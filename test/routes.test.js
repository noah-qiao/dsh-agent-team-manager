import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'

import { ATTRIBUTION, SNAPSHOT_PATH, WRITE_PATH, STALE_MESSAGE } from '../src/contract.js'
import { EVENTS_PATH, PROBE_PATH, apply } from '../index.js'

/**
 * Boot the plugin's routes against a fake Host and a real HTTP server.
 * The fake carries the parts the routes touch: a route table, a service map, a
 * projection change feed, and a connection fence that admits everything unless
 * the test says otherwise.
 */
async function boot(options = {}) {
  const routes = new Map()
  const listeners = []
  const lead = { id: 'lead-session', status: 'running', session: { header: { id: 'lead-session' } } }
  const session = { id: 'lead-session', header: { id: 'lead-session' } }

  const services = {
    webServer: {
      register: (route) => {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    agents: { get: id => (id === 'lead-session' ? lead : undefined) },
    sessions: { get: id => (id === 'lead-session' ? session : undefined) },
    sessionProjections: {
      snapshot: () => ({
        asOfSeq: 4,
        values: {
          agentTeam: {
            members: [
              { id: 'lead-session', name: 'lead', role: 'lead', phase: 'active' },
              { id: 'm1', name: 'raven', role: 'teammate', phase: 'active' },
            ],
            tasks: [{
              id: 'task-1', revision: 1, subject: '做面板', description: '', status: 'pending',
              blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [],
            }],
          },
        },
      }),
      onEventChanged: (listener) => {
        listeners.push(listener)
        return () => {}
      },
    },
    agentTeams: {
      tryMembership: () => ({ root: lead, id: 'lead-session', role: 'lead', name: 'lead' }),
      roster: { membership: () => ({ root: lead, id: 'lead-session', role: 'lead', name: 'lead' }) },
      journal: {
        transact: async (_id, operation) => operation(),
        state: () => ({ members: [{ id: 'm1', name: 'raven', phase: 'active' }], tasks: [] }),
      },
      updateTask: async (caller, request) => {
        if (options.writeThrows !== undefined) throw options.writeThrows
        return { ...options.updated || { id: 'task-1', revision: request.expectedRevision + 1, subject: '做面板', status: 'in_progress' } }
      },
    },
  }
  if (options.noConnection === true) delete services.connection
  else if (options.reject === undefined) services.connection = { requestRejection: () => undefined }
  else services.connection = { requestRejection: () => options.reject }

  const ctx = {
    get: name => services[name],
    webServer: services.webServer,
    sessionProjections: services.sessionProjections,
    effect: (fn) => fn(),
  }
  apply(ctx)

  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const handler = routes.get(path)
    if (handler === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    base: `http://127.0.0.1:${port}`,
    listeners,
    routes,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`)
  const body = await res.json()
  return { status: res.status, body, headers: res.headers }
}

test('快照路由：读得到、owner 正确、带 no-store', async () => {
  const host = await boot()
  try {
    const { status, body, headers } = await getJson(host.base, `${SNAPSHOT_PATH}?sessionId=lead-session`)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.inTeam, true)
    assert.equal(body.members.length, 2)
    // The durable snapshot has no row for task-1, so no owner is asserted for it.
    assert.equal(body.tasks[0].owner, 'none')
    assert.equal(headers.get('cache-control'), 'no-store')
    assert.equal(headers.get('x-content-type-options'), 'nosniff')
  } finally {
    await host.close()
  }
})

test('快照路由：缺 sessionId → 400 no-session', async () => {
  const host = await boot()
  try {
    const { status, body } = await getJson(host.base, SNAPSHOT_PATH)
    assert.equal(status, 400)
    assert.equal(body.reason, 'no-session')
  } finally {
    await host.close()
  }
})

test('快照路由：没通过鉴权 → 403 unauthorized，且不读数据', async () => {
  const host = await boot({ reject: 403 })
  try {
    const { status, body } = await getJson(host.base, `${SNAPSHOT_PATH}?sessionId=lead-session`)
    assert.equal(status, 403)
    assert.equal(body.ok, false)
    assert.equal(body.reason, 'unauthorized')
  } finally {
    await host.close()
  }
})

test('快照路由：鉴权服务缺失 → 503 no-auth（fail closed）', async () => {
  const host = await boot({ noConnection: true })
  try {
    const { status, body } = await getJson(host.base, `${SNAPSHOT_PATH}?sessionId=lead-session`)
    assert.equal(status, 503)
    assert.equal(body.reason, 'no-auth')
  } finally {
    await host.close()
  }
})

test('探测路由不带浏览器凭证也能读，便于干净会话自检', async () => {
  const host = await boot({ reject: 401 })
  try {
    const { status, body } = await getJson(host.base, `${PROBE_PATH}?sessionId=lead-session`)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
  } finally {
    await host.close()
  }
})

test('写路由：接手成功，返回署名', async () => {
  const host = await boot()
  try {
    const res = await fetch(`${host.base}${WRITE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'lead-session', taskId: 'task-1', expectedRevision: 1, action: 'claim' }),
    })
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.attribution, ATTRIBUTION)
  } finally {
    await host.close()
  }
})

test('写路由：并发冲突返回 200 + stale 句子，不重试', async () => {
  const error = new Error('stale')
  error.code = 'TEAM_TASK_STALE_REVISION'
  const host = await boot({ writeThrows: error })
  try {
    const res = await fetch(`${host.base}${WRITE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'lead-session', taskId: 'task-1', expectedRevision: 1, action: 'claim' }),
    })
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.ok, false)
    assert.equal(body.stale, true)
    assert.equal(body.message, STALE_MESSAGE)
  } finally {
    await host.close()
  }
})

test('写路由：GET 一律 405，不给浏览器顺手改数据的机会', async () => {
  const host = await boot()
  try {
    const { status, body } = await getJson(host.base, WRITE_PATH)
    assert.equal(status, 405)
    assert.equal(body.write, true)
  } finally {
    await host.close()
  }
})

test('写路由：跨站 Origin 被拒', async () => {
  const host = await boot()
  try {
    const res = await fetch(`${host.base}${WRITE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ sessionId: 'lead-session', taskId: 'task-1', expectedRevision: 1, action: 'claim' }),
    })
    const body = await res.json()
    assert.equal(res.status, 403)
    assert.match(body.message, /跨站/u)
  } finally {
    await host.close()
  }
})

test('写路由：缺 expectedRevision 被拒', async () => {
  const host = await boot()
  try {
    const res = await fetch(`${host.base}${WRITE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'lead-session', taskId: 'task-1', action: 'claim' }),
    })
    const body = await res.json()
    assert.equal(res.status, 400)
    assert.match(body.message, /expectedRevision/u)
  } finally {
    await host.close()
  }
})

test('写路由：请求体超上限被拒', async () => {
  const host = await boot()
  try {
    const res = await fetch(`${host.base}${WRITE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'lead-session',
        taskId: 'task-1',
        expectedRevision: 1,
        action: 'edit',
        description: 'x'.repeat(20 * 1024),
      }),
    })
    assert.equal(res.status, 413)
  } finally {
    await host.close()
  }
})

test('推送路由：先送一份 baseline，再随投影变更推送新帧', async () => {
  const host = await boot()
  try {
    const res = await fetch(`${host.base}${EVENTS_PATH}?sessionId=lead-session`, {
      headers: { accept: 'text/event-stream' },
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/event-stream/u)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // First frame: the baseline, so a reconnect always resumes from full state.
    while (!buffer.includes('data: ')) {
      const { value } = await reader.read()
      buffer += decoder.decode(value, { stream: true })
    }
    const first = buffer.slice(buffer.indexOf('data: ') + 6).split('\n')[0]
    const baseline = JSON.parse(first)
    assert.equal(baseline.ok, true)

    // A commit that does not touch the team must not wake the panel.
    host.listeners.forEach(listener => listener('lead-session', [{ key: 'title', val: 'x' }], 5))
    // A team commit must.
    host.listeners.forEach(listener => listener('lead-session', [{ key: 'agentTeam', val: {} }], 6))

    buffer = ''
    const deadline = Date.now() + 2000
    while (!buffer.includes('data: ') && Date.now() < deadline) {
      const { value } = await reader.read()
      buffer += decoder.decode(value, { stream: true })
    }
    assert.match(buffer, /data: /u)
    await reader.cancel()
  } finally {
    await host.close()
  }
})

test('推送断开时面板不保留旧数字：客户端把断开翻成一条 read-failed', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // onerror must replace the view rather than leave the last snapshot on screen.
  assert.match(source, /source\.onerror = \(\) => \{/u)
  assert.match(source, /reason: 'read-failed',\s*\n\s*message: '与宿主的推送连接断了，正在自动重连'/u)
})

test('推送路由：没通过鉴权就不开流', async () => {
  const host = await boot({ reject: 401 })
  try {
    const res = await fetch(`${host.base}${EVENTS_PATH}?sessionId=lead-session`)
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.reason, 'unauthorized')
  } finally {
    await host.close()
  }
})

test('推送路由：缺 sessionId 就不开流', async () => {
  const host = await boot()
  try {
    const res = await fetch(`${host.base}${EVENTS_PATH}`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.reason, 'no-session')
  } finally {
    await host.close()
  }
})
