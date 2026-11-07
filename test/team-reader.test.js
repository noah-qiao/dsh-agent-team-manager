import test from 'node:test'
import assert from 'node:assert/strict'

import {
  liveAgentOf,
  ownerOf,
  readTeam,
  resolveCaller,
  runtimeStatus,
  snapshotTask,
} from '../src/host/team-reader.js'

/** Minimal Host context: a service table with `get`. */
function makeCtx(services) {
  return { get: name => services[name] }
}

/** Drop one service key so the reader sees the profile without it. */
function without(services, key) {
  const copy = { ...services }
  delete copy[key]
  return makeCtx(copy)
}

function agent(id, status = 'running') {
  return { id, status, session: { header: { id } } }
}

function teamView(overrides = {}) {
  return {
    members: [
      { id: 'lead-session', name: 'lead', role: 'lead', phase: 'active' },
      { id: 'm1', name: 'raven', role: 'teammate', phase: 'active' },
    ],
    tasks: [
      {
        id: 'task-1', revision: 3, subject: '写规格', description: '', status: 'in_progress',
        blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [],
      },
      {
        id: 'task-2', revision: 1, subject: '做面板', description: '', status: 'pending',
        blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [],
      },
    ],
    ...overrides,
  }
}

function durableJournal(state) {
  return {
    transact: async (_rootId, operation) => operation(),
    state: () => state,
  }
}

function services(options = {}) {
  const lead = agent('lead-session', options.leadStatus || 'running')
  const teammate = agent('m1', options.teammateStatus || 'inactive')
  const agents = new Map([['lead-session', lead], ['m1', teammate]])
  const session = { id: 'lead-session', header: { id: 'lead-session' } }
  const teams = {
    tryMembership: options.tryMembership || (() => ({
      root: lead, id: 'lead-session', role: 'lead', name: 'lead',
    })),
    roster: { membership: () => ({ root: lead, id: 'lead-session', role: 'lead', name: 'lead' }) },
    journal: options.journal === undefined
      ? durableJournal({
        members: [{ id: 'm1', name: 'raven', phase: 'active' }],
        tasks: [
          { id: 'task-1', revision: 3, ownerId: 'lead-session', description: 'Lead 的活' },
          { id: 'task-2', revision: 1, description: '' },
        ],
      })
      : options.journal,
    ...options.teams,
  }
  const sessionProjections = {
    snapshot: options.snapshot || (() => ({ asOfSeq: 9, values: { agentTeam: options.view || teamView() } })),
  }
  return {
    agents: { get: id => agents.get(id) },
    sessions: { get: id => (id === 'lead-session' ? session : undefined) },
    agentTeams: teams,
    sessionProjections,
  }
}

test('Lead 持有的任务恢复成 owner=lead（客户端投影丢了 ownerName）', async () => {
  const payload = await readTeam(makeCtx(services()), 'lead-session')
  assert.equal(payload.ok, true)
  const task = payload.tasks.find(item => item.id === 'task-1')
  assert.equal(task.owner, 'lead')
  assert.equal(task.ownerName, 'lead')
  const other = payload.tasks.find(item => item.id === 'task-2')
  assert.equal(other.owner, 'none')
  assert.equal(payload.ownerSource, 'durable')
})

test('成员持有与无人持有分别命名', () => {
  const members = new Map([['m1', { id: 'm1', name: 'raven' }]])
  assert.deepEqual(ownerOf({ ownerId: 'm1' }, 'lead-session', members), { owner: 'teammate', ownerName: 'raven' })
  assert.deepEqual(ownerOf({}, 'lead-session', members), { owner: 'none' })
  assert.deepEqual(ownerOf(undefined, 'lead-session', members), { owner: 'none' })
})

test('名册丢了成员行时用 id 命名，不谎称无主', () => {
  assert.deepEqual(ownerOf({ ownerId: 'ghost' }, 'lead-session', new Map()), { owner: 'teammate', ownerName: 'ghost' })
})

test('读不到 durable 状态时 owner 标 undeclared，不猜', async () => {
  const payload = await readTeam(makeCtx(services({ journal: undefined, teams: { journal: undefined } })), 'lead-session')
  assert.equal(payload.ok, true)
  assert.equal(payload.ownerSource, 'undeclared')
  for (const task of payload.tasks) assert.equal(task.owner, 'undeclared')
})

test('durable 读取失败也降级为 undeclared，而不是整页失败', async () => {
  const journal = { transact: async () => Promise.reject(new Error('nope')), state: () => ({}) }
  const payload = await readTeam(makeCtx(services({ journal, teams: { journal } })), 'lead-session')
  assert.equal(payload.ok, true)
  assert.equal(payload.ownerSource, 'undeclared')
})

test('快照带 asOfSeq、成员、任务与写面状态', async () => {
  const payload = await readTeam(makeCtx(services()), 'lead-session')
  assert.equal(payload.asOfSeq, 9)
  assert.equal(payload.teamId, 'lead-session')
  assert.equal(payload.members.length, 2)
  assert.equal(payload.tasks.length, 2)
  assert.equal(payload.writeEnabled, true)
  assert.equal(payload.writeDisabledReason, undefined)
})

test('写面关闭时快照明说原因', async () => {
  const payload = await readTeam(makeCtx(services()), 'lead-session', { writeDisabledReason: '没有 Lead 实例' })
  assert.equal(payload.writeEnabled, false)
  assert.equal(payload.writeDisabledReason, '没有 Lead 实例')
})

test('成员运行态来自活 Agent；没有活 Agent 时说 unknown 而不是 inactive', () => {
  assert.deepEqual(runtimeStatus(agent('x', 'running'), 'active'), { status: 'running', statusLive: true, diagnostics: [] })
  assert.deepEqual(runtimeStatus(agent('x', 'idle'), 'active'), { status: 'inactive', statusLive: true, diagnostics: [] })
  assert.deepEqual(runtimeStatus(undefined, 'active'), { status: 'unknown', statusLive: false, diagnostics: [] })
  assert.deepEqual(runtimeStatus(undefined, 'provisioning'), { status: 'provisioning', statusLive: false, diagnostics: [] })
  assert.deepEqual(runtimeStatus(undefined, 'failed', 'boom'), { status: 'failed', statusLive: false, diagnostics: ['boom'] })
})

test('session 没有活 Agent → no-agent，不是空列表', async () => {
  const ctx = makeCtx(services())
  const payload = await readTeam(ctx, 'ghost-session')
  assert.equal(payload.ok, false)
  assert.equal(payload.reason, 'no-agent')
})

test('缺 agentTeams → no-service', async () => {
  const payload = await readTeam(without(services(), 'agentTeams'), 'lead-session')
  assert.equal(payload.reason, 'no-service')
})

test('缺 sessionProjections → no-service 并说清是哪个服务', async () => {
  const ctx = without(services(), 'sessionProjections')
  const payload = await readTeam(ctx, 'lead-session')
  assert.equal(payload.reason, 'no-service')
  assert.match(payload.message, /sessionProjections/u)
})

test('不属于任何团队 → ok:true + inTeam:false，与读取失败区分', async () => {
  const ctx = makeCtx(services({ tryMembership: () => undefined }))
  const payload = await readTeam(ctx, 'lead-session')
  assert.deepEqual(payload, { ok: true, inTeam: false })
})

test('投影进入失败态 → read-failed 并带失败原因', async () => {
  const ctx = makeCtx(services({ view: teamView({ failure: 'revision gap' }) }))
  const payload = await readTeam(ctx, 'lead-session')
  assert.equal(payload.reason, 'read-failed')
  assert.match(payload.message, /revision gap/u)
})

test('agentTeam 投影没注册 → no-service', async () => {
  const view = undefined
  const ctx = makeCtx({
    ...services(),
    sessionProjections: { snapshot: () => ({ asOfSeq: 9, values: {} }) },
  })
  assert.equal(view, undefined)
  const payload = await readTeam(ctx, 'lead-session')
  assert.equal(payload.ok, false)
  assert.equal(payload.reason, 'no-service')
})

test('投影读取抛错 → read-failed，不抛出', async () => {
  const ctx = makeCtx(services({
    snapshot: () => {
      throw new Error('log unreadable')
    },
  }))
  const payload = await readTeam(ctx, 'lead-session')
  assert.equal(payload.reason, 'read-failed')
  assert.match(payload.message, /log unreadable/u)
})

test('团队成员会话解析到自己的 Agent；团队数据仍从 Lead 读', async () => {
  const lead = agent('lead-session')
  const child = agent('child', 'idle')
  child.session.header.parentSession = 'lead-session'
  const ctx = makeCtx({
    agents: { get: id => (id === 'child' ? child : id === 'lead-session' ? lead : undefined) },
    sessions: { get: id => (id === 'lead-session' ? { id: 'lead-session', header: { id: 'lead-session' } } : undefined) },
  })
  assert.equal(resolveCaller(ctx, 'child').leadSessionId, 'lead-session')
  assert.equal(resolveCaller(ctx, 'child').agent, child)
  assert.equal(liveAgentOf(ctx, 'child'), child)
})

test('已归档的团队成员会话回落到 Lead 的 Agent', () => {
  const lead = agent('lead-session')
  const ctx = makeCtx({
    agents: { get: id => (id === 'lead-session' ? lead : undefined) },
    sessions: { get: id => (id === 'child' ? { id: 'child', header: { id: 'child', parentSession: 'lead-session' } } : undefined) },
  })
  const resolved = resolveCaller(ctx, 'child')
  assert.equal(resolved.agent, lead)
  assert.equal(resolved.leadSessionId, 'lead-session')
})

test('任何会话都解析不到 Agent 时 resolveCaller 返回空', () => {
  const ctx = makeCtx({ agents: { get: () => undefined }, sessions: { get: () => undefined } })
  assert.deepEqual(resolveCaller(ctx, 'nobody'), {})
})

test('snapshotTask 用 durable 描述补齐客户端投影丢掉的部分', () => {
  const view = { id: 'task-1', revision: 3, subject: '写规格', description: '', status: 'in_progress', blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [] }
  const row = snapshotTask(view, { description: 'Lead 的活' }, { owner: 'lead', ownerName: 'lead' })
  assert.equal(row.description, 'Lead 的活')
  assert.equal(row.owner, 'lead')
  assert.equal(row.revision, 3)
  assert.equal(snapshotTask(view, undefined, { owner: 'undeclared' }).owner, 'undeclared')
})

test('快照不含消息原文：字段白名单之外的一律不带', async () => {
  const payload = await readTeam(makeCtx(services()), 'lead-session')
  const flat = JSON.stringify(payload)
  assert.doesNotMatch(flat, /content|senderName|messageId/u)
})
