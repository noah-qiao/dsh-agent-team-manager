import test from 'node:test'
import assert from 'node:assert/strict'

import { ATTRIBUTION, MAX_WRITE_BODY_BYTES, STALE_MESSAGE } from '../src/contract.js'
import { codeOf, parseWriteRequest, performWrite, serviceRequest } from '../src/host/writes.js'

const LEAD = 'lead-session'

function taskView(overrides = {}) {
  return {
    id: 'task-2',
    revision: 2,
    subject: '做面板',
    description: '',
    status: 'in_progress',
    blockedBy: [],
    writeScopes: [],
    ownerName: undefined,
    ready: false,
    writeScopeWarnings: [],
    ...overrides,
  }
}

/** Map of fake `TeamError`s the way `@deepseek-ai/dsh-llm` raises them. */
function teamError(code, message = code) {
  const error = new Error(message)
  error.code = code
  error.name = 'TeamError'
  return error
}

function makeCtx(options = {}) {
  const lead = { id: LEAD, status: 'running', session: { header: { id: LEAD } } }
  const calls = []
  const teams = {
    tryMembership: () => (options.role === 'teammate'
      ? { root: lead, id: LEAD, role: 'teammate', name: 'raven' }
      : { root: lead, id: LEAD, role: 'lead', name: 'lead' }),
    updateTask: async (caller, request) => {
      calls.push({ caller, request })
      if (options.throws !== undefined) throw options.throws
      return taskView({ revision: request.expectedRevision + 1, subject: request.subject ?? '做面板' })
    },
  }
  const services = {
    agents: { get: id => (id === LEAD ? lead : undefined) },
    sessions: { get: id => (id === LEAD ? { id: LEAD, header: { id: LEAD } } : undefined) },
    agentTeams: teams,
  }
  if (options.noService === true) delete services.agentTeams
  return { ctx: { get: name => services[name] }, calls }
}

test('请求体校验：三条操作各一条合法请求', () => {
  const claim = parseWriteRequest({ sessionId: LEAD, taskId: 'task-2', expectedRevision: 1, action: 'claim' })
  assert.equal(claim.ok, true)
  const release = parseWriteRequest({ sessionId: LEAD, taskId: 'task-1', expectedRevision: 4, action: 'release' })
  assert.equal(release.ok, true)
  const edit = parseWriteRequest({ sessionId: LEAD, taskId: 'task-1', expectedRevision: 4, action: 'edit', subject: '新标题' })
  assert.equal(edit.ok, true)
  assert.equal(edit.request.subject, '新标题')
})

test('同时改标题与描述都带上', () => {
  const edit = parseWriteRequest({
    sessionId: LEAD, taskId: 'task-1', expectedRevision: 1, action: 'edit', subject: ' s ', description: ' d ',
  })
  assert.equal(edit.ok, true)
  assert.equal(edit.request.subject, ' s ')
  assert.equal(edit.request.description, ' d ')
})

test('缺 expectedRevision 一律拒绝：没有盲写路径', () => {
  for (const expectedRevision of [undefined, null, 0, -1, 1.5, '3']) {
    const parsed = parseWriteRequest({ sessionId: LEAD, taskId: 'task-2', expectedRevision, action: 'claim' })
    assert.equal(parsed.ok, false, String(expectedRevision))
    assert.match(parsed.message, /expectedRevision/u)
  }
})

test('不在白名单里的动作拒绝：不开放 reassign / complete / interrupt', () => {
  for (const action of ['reassign', 'complete', 'reopen', 'delete', 'interrupt', 'set_dependencies']) {
    const parsed = parseWriteRequest({ sessionId: LEAD, taskId: 'task-2', expectedRevision: 1, action })
    assert.equal(parsed.ok, false, action)
  }
})

test('改一改两个字段都不给时拒绝', () => {
  const parsed = parseWriteRequest({ sessionId: LEAD, taskId: 'task-1', expectedRevision: 1, action: 'edit' })
  assert.equal(parsed.ok, false)
})

test('标题过长或为空时拒绝', () => {
  assert.equal(parseWriteRequest({ sessionId: LEAD, taskId: 'task-1', expectedRevision: 1, action: 'edit', subject: '   ' }).ok, false)
  assert.equal(parseWriteRequest({ sessionId: LEAD, taskId: 'task-1', expectedRevision: 1, action: 'edit', subject: 'x'.repeat(201) }).ok, false)
  // 16384 is the service's own limit; a maximum-length description must pass here.
  assert.equal(parseWriteRequest({ sessionId: LEAD, taskId: 'task-1', expectedRevision: 1, action: 'edit', description: 'd'.repeat(16384) }).ok, true)
})

test('请求体大小上限写在契约里', () => {
  assert.equal(MAX_WRITE_BODY_BYTES, 16 * 1024)
})

test('服务请求永远带 expectedRevision，改一改只带给出的字段', () => {
  const claim = serviceRequest({ taskId: 'task-2', expectedRevision: 7, action: 'claim' })
  assert.deepEqual(claim, { taskId: 'task-2', expectedRevision: 7, action: 'claim' })
  const edit = serviceRequest({ taskId: 'task-1', expectedRevision: 7, action: 'edit', description: '只有描述' })
  assert.deepEqual(edit, { taskId: 'task-1', expectedRevision: 7, action: 'edit', description: '只有描述' })
})

test('接手成功：以 Lead 的活 Agent 作 caller，并带署名', async () => {
  const { ctx, calls } = makeCtx()
  const payload = await performWrite(ctx, { sessionId: LEAD, taskId: 'task-2', expectedRevision: 1, action: 'claim' })
  assert.equal(payload.ok, true)
  assert.equal(payload.attribution, ATTRIBUTION)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].caller.id, LEAD)
  assert.equal(calls[0].request.expectedRevision, 1)
  assert.equal(calls[0].request.action, 'claim')
  assert.equal(payload.task.owner, 'none')
})

test('放回成功', async () => {
  const { ctx, calls } = makeCtx()
  const payload = await performWrite(ctx, { sessionId: LEAD, taskId: 'task-1', expectedRevision: 4, action: 'release' })
  assert.equal(payload.ok, true)
  assert.equal(calls[0].request.action, 'release')
  assert.equal(calls[0].request.expectedRevision, 4)
})

test('改一改成功', async () => {
  const { ctx, calls } = makeCtx()
  const payload = await performWrite(ctx, {
    sessionId: LEAD, taskId: 'task-1', expectedRevision: 4, action: 'edit', subject: '新标题',
  })
  assert.equal(payload.ok, true)
  assert.equal(calls[0].request.subject, '新标题')
})

test('并发冲突：TEAM_TASK_STALE_REVISION 翻成「别人刚改过，刷新再看看」，不吞、不重试', async () => {
  const { ctx, calls } = makeCtx({ throws: teamError('TEAM_TASK_STALE_REVISION') })
  const payload = await performWrite(ctx, { sessionId: LEAD, taskId: 'task-2', expectedRevision: 1, action: 'claim' })
  assert.equal(payload.ok, false)
  assert.equal(payload.stale, true)
  assert.equal(payload.message, STALE_MESSAGE)
  assert.equal(payload.code, 'TEAM_TASK_STALE_REVISION')
  assert.equal(calls.length, 1)
})

test('错误码挂在 cause 上也能认出来', () => {
  const wrapped = new Error('wrapped', { cause: teamError('TEAM_TASK_STALE_REVISION') })
  assert.equal(codeOf(wrapped), 'TEAM_TASK_STALE_REVISION')
})

test('其它 TeamError 保留原始信息，不吃掉', async () => {
  const { ctx } = makeCtx({ throws: teamError('TEAM_TASK_ALREADY_CLAIMED', 'task is owned by another member') })
  const payload = await performWrite(ctx, { sessionId: LEAD, taskId: 'task-2', expectedRevision: 1, action: 'claim' })
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'TEAM_TASK_ALREADY_CLAIMED')
  assert.match(payload.message, /owned by another member/u)
})

test('没有团队服务 → no-service，写面不可用', async () => {
  const { ctx } = makeCtx({ noService: true })
  const payload = await performWrite(ctx, { sessionId: LEAD, taskId: 'task-2', expectedRevision: 1, action: 'claim' })
  assert.equal(payload.reason, 'no-service')
  assert.equal(payload.write, true)
})

test('没有活 Agent → no-agent', async () => {
  const { ctx } = makeCtx()
  const payload = await performWrite(ctx, { sessionId: 'ghost', taskId: 'task-2', expectedRevision: 1, action: 'claim' })
  assert.equal(payload.reason, 'no-agent')
})

test('非 Lead 会话不以 Lead 名义写', async () => {
  const { ctx, calls } = makeCtx({ role: 'teammate' })
  const payload = await performWrite(ctx, { sessionId: LEAD, taskId: 'task-2', expectedRevision: 1, action: 'claim' })
  assert.equal(payload.ok, false)
  assert.match(payload.message, /Lead/u)
  assert.equal(calls.length, 0)
})

test('成功响应的 owner 由 ownerName 翻转，不凭空补', async () => {
  const { ctx } = makeCtx()
  const payload = await performWrite(ctx, { sessionId: LEAD, taskId: 'task-1', expectedRevision: 1, action: 'release' })
  assert.equal(payload.task.owner, 'none')
})
