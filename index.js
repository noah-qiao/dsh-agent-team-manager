/**
 * @local/dsh-agent-manager — Host half.
 *
 * Registers two routes next to the SPA, plus one read-only CLI probe:
 *
 *   GET  /agent-manager/snapshot?sessionId=…  → team snapshot (or a named failure)
 *   GET  /agent-manager/events?sessionId=…    → server-sent push of snapshots
 *   POST /agent-manager/write                 → claim / release / edit
 *   GET  /agent-manager/probe?sessionId=…     → CLI smoke check, no browser credential needed
 *
 * Both routes sit outside the SPA's own gate, so each one fails closed through
 * `connection.requestRejection` before doing any work. The write route
 * additionally caps its body and refuses cross-origin callers even when the
 * connection service itself is missing.
 *
 * Push, not polling: the client opens the events stream once and the Host
 * re-reads the snapshot whenever the `agentTeam` projection changes
 * (`sessionProjections.onEventChanged`). Reconnection is the browser's job —
 * `EventSource` retries on its own, and every retry gets a fresh baseline
 * frame, so a dropped connection catches up without any manual refresh and
 * without a timer in this plugin.
 */
import {
  MAX_WRITE_BODY_BYTES,
  SNAPSHOT_PATH,
  WRITE_PATH,
  failure,
  statusOf,
} from './src/contract.js'
import { readTeam, resolveCaller } from './src/host/team-reader.js'
import { performWrite, parseWriteRequest } from './src/host/writes.js'

/** Server-sent push of snapshots; the browser owns reconnection. */
export const EVENTS_PATH = '/agent-manager/events'
/** CLI probe: same payload as the snapshot route, excluding socket-only auth. */
export const PROBE_PATH = '/agent-manager/probe'

/** The projection key whose changes wake the push stream. */
const TEAM_KEY = 'agentTeam'

/**
 * Why the write surface is off, when it is off.
 *
 * The panel must never draw a working-looking button it cannot honour. Two
 * things can make writing impossible, and both are checked here rather than at
 * click time:
 *
 *   1. the team service is missing from the profile;
 *   2. there is no live Lead Agent in this Host process to sign as. Every
 *      `agentTeams` method takes a live Agent as the caller, and the plugin
 *      has no identity of its own — without a Lead there is nothing to write
 *      under, so the panel is read-only and says why.
 *
 * Checking (2) needs the session, so the reason is resolved per snapshot.
 * @param {object} ctx Host context
 * @param {string} [sessionId] session whose Lead would sign; omit to check only the service
 * @returns {string|undefined} reason, or `undefined` when writes are possible
 */
export function writeDisabledReason(ctx, sessionId) {
  const teams = ctx.get('agentTeams')
  if (teams === undefined || teams === null || typeof teams.updateTask !== 'function') {
    return '当前 profile 没有 agentTeams 服务，面板只读'
  }
  if (sessionId === undefined) return undefined
  const { agent } = resolveCaller(ctx, sessionId)
  if (agent === undefined) {
    return '宿主进程里没有这个会话的 Lead 实例，写不了，面板只读'
  }
  return undefined
}

/** Answer one JSON payload with the headers a private route needs. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(text)
}

/**
 * Ask the connection service whether this request may be answered.
 * @param {object} ctx Host context
 * @param {object} req incoming request
 * @returns {number|undefined} rejection status, or undefined when admitted
 */
function rejectionOf(ctx, req) {
  const connection = ctx.get('connection')
  if (connection === undefined || connection === null) return 503
  if (typeof connection.requestRejection !== 'function') return 503
  try {
    return connection.requestRejection(req)
  } catch {
    return 500
  }
}

/**
 * Refuse a write whose Origin names another site.
 * The connection fence already rejects cross-site callers; this is the second
 * lock for the one route that mutates, so a misconfigured fence cannot silently
 * turn into a CSRF hole.
 * @param {object} req incoming request
 * @returns {boolean} true when the origin is this server
 */
function sameOrigin(req) {
  const origin = req.headers?.origin
  if (origin === undefined) return true
  const host = req.headers?.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read one bounded JSON body. */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish({ ok: false, status: 413, message: `请求体超过 ${limit} 字节上限` })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      try {
        const text = (globalThis.Buffer === undefined
          ? chunks.map(chunk => String(chunk)).join('')
          : globalThis.Buffer.concat(chunks).toString('utf8'))
        finish({ ok: true, value: JSON.parse(text) })
      } catch {
        finish({ ok: false, status: 400, message: '请求体不是合法 JSON' })
      }
    })
    req.on('error', () => finish({ ok: false, status: 400, message: '读取请求体失败' }))
  })
}

/** Pull one query parameter off a request URL without throwing. */
function queryParam(req, name) {
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams.get(name) || undefined
  } catch {
    return undefined
  }
}

/**
 * Register the read route used by both the snapshot fetch and the probe.
 * @param {object} ctx Host context
 * @param {string} path route path
 * @param {boolean} needsAuth whether the route answers only authenticated callers
 * @returns {() => void} disposer
 */
function registerReadRoute(ctx, path, needsAuth) {
  return ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (needsAuth) {
        const rejection = rejectionOf(ctx, req)
        if (rejection !== undefined) {
          sendJson(res, rejection, failure(
            rejection === 503 ? 'no-auth' : 'unauthorized',
            rejection === 503 ? '鉴权服务不可用，已拒绝响应' : '未授权的请求',
          ))
          return
        }
      }
      const sessionId = queryParam(req, 'sessionId')
      if (sessionId === undefined) {
        sendJson(res, 400, failure('no-session', '缺少 sessionId 参数'))
        return
      }
      const payload = await readTeam(ctx, sessionId, { writeDisabledReason: writeDisabledReason(ctx, sessionId) })
      sendJson(res, payload.ok === true ? 200 : statusOf(payload.reason), payload)
    },
  })
}

export function apply(ctx) {
  ctx.effect(() => registerReadRoute(ctx, SNAPSHOT_PATH, true), 'agent-manager: snapshot route')
  ctx.effect(() => registerReadRoute(ctx, PROBE_PATH, false), 'agent-manager: probe route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: WRITE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, failure('read-failed', '写路由只接受 POST', true))
        return
      }
      const rejection = rejectionOf(ctx, req)
      if (rejection !== undefined) {
        sendJson(res, rejection, failure(
          rejection === 503 ? 'no-auth' : 'unauthorized',
          rejection === 503 ? '鉴权服务不可用，已拒绝写入' : '未授权的写入请求',
          true,
        ))
        return
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, failure('unauthorized', '跨站来源的写入请求被拒绝', true))
        return
      }
      // The write route re-checks without a session first (service only); the
      // no-Lead case is already reported by the snapshot, and performWrite
      // answers `no-agent` if a click still races past it.
      const disabled = writeDisabledReason(ctx)
      if (disabled !== undefined) {
        sendJson(res, 503, failure('no-service', disabled, true))
        return
      }
      const body = await readBody(req, MAX_WRITE_BODY_BYTES)
      if (body.ok === false) {
        sendJson(res, body.status, failure('read-failed', body.message, true))
        return
      }
      const parsed = parseWriteRequest(body.value)
      if (parsed.ok === false) {
        sendJson(res, 400, failure('read-failed', parsed.message, true))
        return
      }
      const payload = await performWrite(ctx, parsed.request)
      sendJson(res, payload.ok === true || payload.stale === true ? 200 : 500, payload)
    },
  }), 'agent-manager: write route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EVENTS_PATH,
    handler: async (req, res) => {
      const rejection = rejectionOf(ctx, req)
      if (rejection !== undefined) {
        sendJson(res, rejection, failure(
          rejection === 503 ? 'no-auth' : 'unauthorized',
          rejection === 503 ? '鉴权服务不可用，已拒绝订阅' : '未授权的订阅请求',
        ))
        return
      }
      const sessionId = queryParam(req, 'sessionId')
      if (sessionId === undefined) {
        sendJson(res, 400, failure('no-session', '缺少 sessionId 参数'))
        return
      }

      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('connection', 'keep-alive')
      res.setHeader('x-accel-buffering', 'no')
      res.write(': connected\n\n')

      let closed = false
      let reading = false
      let dirty = false

      const push = async () => {
        if (closed) return
        if (reading) {
          // A change landed while a read was in flight; read again after it.
          dirty = true
          return
        }
        reading = true
        try {
          const payload = await readTeam(ctx, sessionId, { writeDisabledReason: writeDisabledReason(ctx, sessionId) })
          if (closed) return
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
        } catch (error) {
          if (closed) return
          res.write(`data: ${JSON.stringify(failure('read-failed', '推送时读取团队快照失败'))}\n\n`)
          // The detail goes to the Host log: the browser is not a log sink.
          console.error('[agent-manager] push read failed', error)
        } finally {
          reading = false
          if (dirty && !closed) {
            dirty = false
            void push()
          }
        }
      }

      // Baseline first: a reconnecting stream always starts from a full state,
      // which is what makes reconnect catch up without a refresh.
      await push()

      if (typeof ctx.sessionProjections?.onEventChanged !== 'function') {
        res.write(`data: ${JSON.stringify(failure('no-service', '投影变更信号不可用，界面不会自己更新'))}\n\n`)
      } else {
        ctx.sessionProjections.onEventChanged((session, changes) => {
          if (!Array.isArray(changes)) return
          if (!changes.some(change => change && change.key === TEAM_KEY)) return
          void push()
        })
      }

      await new Promise((resolve) => {
        const close = () => {
          if (closed) return
          closed = true
          resolve()
        }
        req.on('close', close)
        req.on('aborted', close)
        res.on('close', close)
      })
    },
  }), 'agent-manager: events route')
}

/**
 * `agentTeams` and `connection` are deliberately absent.
 *
 * A hard inject makes the plugin unloadable on a profile that lacks the
 * service. A profile without `agentTeams` should still show a panel that says
 * "看不到：当前 profile 没有 agentTeams 服务", and a profile without
 * `connection` should still answer fail-closed 503s. Both are checked with
 * `ctx.get(...)` at request time, which gives the same refusal without
 * blacking the plugin out.
 */
export const inject = ['webServer', 'agents', 'sessions', 'sessionProjections']
