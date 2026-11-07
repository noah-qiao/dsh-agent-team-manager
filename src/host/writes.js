/**
 * Host half: the three v1 writes, all through one CAS entry.
 *
 * `agentTeams.updateTask(caller, { taskId, expectedRevision, action, ... })` is
 * the only mutation entry point the team domain has, and every action on it
 * must carry the revision the client last read. That is the whole concurrency
 * story: a second writer that read an older revision loses with
 * `TEAM_TASK_STALE_REVISION`, and this module turns that code into a sentence
 * instead of swallowing it or retrying.
 *
 * Attribution: the caller is the live Lead Agent instance held by the Host
 * process. The Host cannot sign as the browser user, so every success payload
 * carries `ATTRIBUTION` and the panel prints it. That is the fact, not a
 * disclaimer.
 *
 * Reads the current revision before deciding anything is forbidden: the panel
 * sends what it drew, and a mismatch is the honest signal that the screen is
 * stale.
 */
import {
  ATTRIBUTION,
  STALE_MESSAGE,
  STALE_REVISION_CODE,
  WRITE_ACTIONS,
  failure,
} from '../contract.js'
import { messageOf, resolveCaller } from './team-reader.js'

/** Team task id pattern accepted by the durable schema. */
const TASK_ID = /^[^\s]{1,128}$/u

/**
 * @typedef {object} TeamErrorLike
 * @property {string} [code]
 * @property {TeamErrorLike} [cause]
 */

/**
 * Validate one raw write request body.
 * @param {unknown} body parsed JSON
 * @returns {{ ok: true, request: object } | { ok: false, message: string }}
 */
export function parseWriteRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: '请求体必须是一个 JSON 对象' }
  }
  /** @type {Record<string, any>} */
  const fields = body
  const { sessionId, taskId, expectedRevision, action } = fields
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, message: '缺少 sessionId' }
  }
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
    return { ok: false, message: 'taskId 缺失或格式非法' }
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false, message: 'expectedRevision 必须是上一次读到的正整数 revision' }
  }
  if (!WRITE_ACTIONS.includes(action)) {
    return { ok: false, message: `不支持的操作「${String(action)}」；v1 只有 ${WRITE_ACTIONS.join(' / ')}` }
  }
  if (action === 'edit') {
    const hasSubject = typeof fields.subject === 'string'
    const hasDescription = typeof fields.description === 'string'
    if (!hasSubject && !hasDescription) {
      return { ok: false, message: '改一改至少要给标题或描述其中一项' }
    }
    if (hasSubject && (fields.subject.trim().length === 0 || fields.subject.length > 200)) {
      return { ok: false, message: '标题不能为空，且不超过 200 字' }
    }
    if (hasDescription && fields.description.length > 16384) {
      return { ok: false, message: '描述不超过 16384 字' }
    }
  }
  return {
    ok: true,
    request: {
      sessionId,
      taskId,
      expectedRevision,
      action,
      ...action === 'edit' && typeof fields.subject === 'string' ? { subject: fields.subject } : {},
      ...action === 'edit' && typeof fields.description === 'string' ? { description: fields.description } : {},
    },
  }
}

/**
 * Build the `agentTeams.updateTask` request for one validated write.
 * The CAS field is always present: there is no path that writes blind.
 * @param {object} write validated write request
 * @returns {object} service request
 */
export function serviceRequest(write) {
  const request = {
    taskId: write.taskId,
    expectedRevision: write.expectedRevision,
    action: write.action,
  }
  if (write.action === 'edit') {
    if (write.subject !== undefined) request.subject = write.subject
    if (write.description !== undefined) request.description = write.description
  }
  return request
}

/**
 * Read the failure code off any thrown value.
 * `TeamError` sets `code`; a wrapped error may carry it on `cause`.
 * @param {unknown} error
 * @returns {string|undefined}
 */
export function codeOf(error) {
  if (error === null || typeof error !== 'object') return undefined
  /** @type {TeamErrorLike} */
  const candidate = error
  if (typeof candidate.code === 'string') return candidate.code
  return codeOf(candidate.cause)
}

/**
 * Translate one thrown write failure into a payload the panel renders verbatim.
 * A stale revision is its own sentence: the user must know the screen is behind,
 * not that the operation was rejected for some reason.
 * @param {unknown} error
 * @returns {{ ok: false, reason: string, message: string, write: true, stale?: boolean, code?: string }}
 */
export function writeFailure(error) {
  const code = codeOf(error)
  const stale = code === STALE_REVISION_CODE
  const base = failure('read-failed', stale ? STALE_MESSAGE : `写入没有成功：${messageOf(error)}`, true)
  return { ...base, write: true, stale, ...code === undefined ? {} : { code } }
}

/**
 * Perform one write as the runtime Lead.
 * @param {object} ctx Host context
 * @param {object} write validated write request
 * @returns {Promise<object>} success or failure payload; never throws
 */
export async function performWrite(ctx, write) {
  const teams = ctx.get('agentTeams')
  if (teams === undefined || teams === null || typeof teams.updateTask !== 'function') {
    return failure('no-service', '当前 profile 没有启用 agentTeams 服务，写面不可用', true)
  }

  const { agent } = resolveCaller(ctx, write.sessionId)
  if (agent === undefined) {
    return failure('no-agent', '该会话没有存活的 Agent，写面不可用', true)
  }

  let membership
  try {
    membership = teams.tryMembership(agent)
  } catch (error) {
    return failure('read-failed', `无法解析该会话的团队身份：${String(error && error.message || error)}`, true)
  }
  if (membership === undefined) {
    return failure('read-failed', '当前会话不属于任何团队，没有可写的团队', true)
  }
  if (membership.role !== 'lead') {
    return failure('read-failed', '写面只以 Lead 名义操作，当前会话不是 Lead 会话', true)
  }

  try {
    const task = await teams.updateTask(agent, serviceRequest(write))
    return {
      ok: true,
      write: true,
      attribution: ATTRIBUTION,
      task: {
        id: task.id,
        revision: task.revision,
        subject: task.subject,
        status: task.status,
        owner: task.ownerName === undefined ? 'none' : task.ownerName === 'lead' ? 'lead' : 'teammate',
        ...task.ownerName === undefined ? {} : { ownerName: task.ownerName },
      },
    }
  } catch (error) {
    return writeFailure(error)
  }
}
