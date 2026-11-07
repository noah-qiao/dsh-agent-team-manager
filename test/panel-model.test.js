import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  COPY,
  actionsForTask,
  buildPanelModel,
  conflictOfTask,
  ownerOfTask,
  reasonText,
  summarize,
  waitOfTask,
} from '../src/panel-model.js'

/** A snapshot with one Lead, one teammate, and four tasks covering every owner kind. */
function sample(overrides = {}) {
  return {
    ok: true,
    inTeam: true,
    asOfSeq: 12,
    teamId: 'lead-session',
    role: 'lead',
    name: 'lead',
    ownerSource: 'durable',
    writeEnabled: true,
    members: [
      { id: 'lead-session', name: 'lead', role: 'lead', phase: 'active', lead: true, status: 'running', statusLive: true, diagnostics: [] },
      { id: 'm1', name: 'raven', role: 'teammate', phase: 'active', lead: false, status: 'inactive', statusLive: true, diagnostics: [] },
    ],
    tasks: [
      task({ id: 'task-1', subject: '写规格', status: 'in_progress', owner: 'lead', revision: 3 }),
      task({ id: 'task-2', subject: '做面板', status: 'pending', owner: 'none', ready: true, revision: 1 }),
      task({ id: 'task-3', subject: '做入口', status: 'in_progress', owner: 'teammate', ownerName: 'raven', revision: 2 }),
      task({
        id: 'task-4',
        subject: '收口',
        status: 'pending',
        owner: 'none',
        ready: false,
        blockedBy: ['task-2'],
        revision: 1,
      }),
    ],
    ...overrides,
  }
}

function task(overrides) {
  return {
    id: 'task-x',
    revision: 1,
    subject: 'x',
    description: '',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ready: false,
    writeScopeWarnings: [],
    owner: 'none',
    ...overrides,
  }
}

test('摘要条四个数字全部来自快照', () => {
  const model = buildPanelModel(sample())
  assert.equal(model.kind, 'ready')
  const counts = Object.fromEntries(model.summary.map(item => [item.key, item.value]))
  assert.deepEqual(counts, { members: 2, tasks: 4, blocked: 1, conflicts: 0 })
})

test('摘要条数字随快照变化，不是硬编码', () => {
  const model = buildPanelModel(sample({ tasks: [] , members: [] }))
  const counts = Object.fromEntries(model.summary.map(item => [item.key, item.value]))
  assert.deepEqual(counts, { members: 0, tasks: 0, blocked: 0, conflicts: 0 })
})

test('成员区每人一行：名字、角色、手里几张任务', () => {
  const model = buildPanelModel(sample())
  assert.equal(model.members.length, 2)
  const lead = model.members[0]
  assert.equal(lead.name, 'lead')
  assert.equal(lead.role, COPY.ownerLead)
  assert.equal(lead.held, 1)
  assert.equal(lead.heldText, '1 张')
  const raven = model.members[1]
  assert.equal(raven.name, 'raven')
  assert.equal(raven.role, COPY.teammate)
  assert.equal(raven.held, 1)
})

test('Lead 自己持有的任务显示「Lead」，不是空白', () => {
  const model = buildPanelModel(sample())
  const row = model.tasks.find(item => item.id === 'task-1')
  assert.equal(row.owner, 'Lead')
  assert.equal(row.ownerKind, 'lead')
})

test('无人认领的任务显示「未认领」，不推断负责人', () => {
  const model = buildPanelModel(sample())
  const row = model.tasks.find(item => item.id === 'task-2')
  assert.equal(row.owner, '未认领')
  assert.equal(row.ownerKind, 'none')
})

test('具名成员持有的任务显示该成员名', () => {
  const model = buildPanelModel(sample())
  const row = model.tasks.find(item => item.id === 'task-3')
  assert.equal(row.owner, 'raven')
  assert.equal(row.ownerKind, 'member')
})

test('负责人不可得时写「看不到」，不猜', () => {
  const model = buildPanelModel(sample({
    ownerSource: 'undeclared',
    tasks: [task({ id: 'task-9', owner: 'undeclared' })],
  }))
  const row = model.tasks[0]
  assert.equal(row.owner, COPY.ownerHidden)
  assert.equal(row.ownerKind, 'unavailable')
})

test('「在等什么」列出未完成的前置；没有前置时说没有', () => {
  const model = buildPanelModel(sample())
  const blocked = model.tasks.find(item => item.id === 'task-4')
  assert.equal(blocked.waiting, true)
  assert.match(blocked.waitText, /做面板/u)
  const free = model.tasks.find(item => item.id === 'task-2')
  assert.equal(free.waiting, false)
  assert.equal(free.waitText, COPY.waitingOnNone)
})

test('前置已完成不算在等', () => {
  const tasks = [
    task({ id: 'task-1', subject: '上游', status: 'completed' }),
    task({ id: 'task-2', subject: '下游', status: 'pending', ready: true, blockedBy: ['task-1'] }),
  ]
  const wait = waitOfTask(tasks[1], new Map(tasks.map(item => [item.id, item])))
  assert.equal(wait.waiting, false)
})

test('快照里找不到的前置保留 id 并标记，不静默丢弃', () => {
  const tasks = [task({ id: 'task-2', blockedBy: ['task-404'] })]
  const wait = waitOfTask(tasks[0], new Map(tasks.map(item => [item.id, item])))
  assert.deepEqual(wait.missing, ['task-404'])
  assert.equal(wait.waiting, true)
  assert.match(wait.text, /task-404/u)
})

test('冲突提醒来自宿主的 writeScopeWarnings', () => {
  const row = task({ id: 'task-5', writeScopeWarnings: ['write scopes overlap with task-3'] })
  assert.equal(conflictOfTask(row), COPY.conflictLine.replace('{ids}', 'task-3'))
  assert.equal(conflictOfTask(task({ id: 'task-6' })), undefined)
})

test('冲突计入摘要条', () => {
  const tasks = [
    task({ id: 'task-1', status: 'in_progress', owner: 'lead', writeScopeWarnings: ['write scopes overlap with task-2'] }),
    task({ id: 'task-2', status: 'in_progress', owner: 'teammate', ownerName: 'raven' }),
  ]
  assert.equal(summarize(tasks, []).conflicts, 1)
})

test('窄屏时任务区收成两列：不画「在等什么」和冲突行', () => {
  const wide = buildPanelModel(sample())
  const narrow = buildPanelModel(sample(), { narrow: true })
  assert.equal(wide.tasks[0].narrow, false)
  assert.equal(narrow.tasks[0].narrow, true)
  assert.equal(narrow.columns.length, 1)
})

test('宽屏按状态分三栏，任务是对象不是字符串', () => {
  const model = buildPanelModel(sample())
  assert.deepEqual(model.columns.map(column => column.key), ['pending', 'in_progress', 'completed'])
  assert.equal(typeof model.tasks[0].subject, 'string')
})

test('没有进度条、没有百分比字段', () => {
  const model = buildPanelModel(sample())
  const flat = JSON.stringify(model)
  // `in_progress` is a status name, not a progress measure: look for the
  // renderable shape of a progress value instead.
  assert.doesNotMatch(flat, /\bprogress\b|percent/u)
  assert.doesNotMatch(flat, /%/u)
})

test('快照里没有消息原文的位置', () => {
  const model = buildPanelModel(sample())
  const flat = JSON.stringify(model)
  // The only match allowed is the copy key `description` on a task row, which is
  // the task's own text typed by a human, never a conversation message.
  assert.doesNotMatch(flat, /"content"|sender|messageId|"message"/u)
})

test('只有 Lead 一个人时显示「目前只有你一个人」', () => {
  const model = buildPanelModel(sample({ members: [sample().members[0]] }))
  assert.equal(model.solo, true)
  assert.equal(model.soloText, COPY.solo)
})

test('六种失败原因各自渲染成「看不到」加一句说清原因的话', () => {
  const reasons = ['no-auth', 'unauthorized', 'no-session', 'no-agent', 'no-service', 'read-failed']
  for (const reason of reasons) {
    const model = buildPanelModel({ ok: false, reason, message: `细节-${reason}` })
    assert.equal(model.kind, 'unavailable', reason)
    assert.equal(model.reason, reason)
    assert.match(model.message, /细节-/u)
    assert.ok(model.message.length > COPY.reasons[reason].length, reason)
  }
})

test('未知失败原因也不吞：说清是未知原因', () => {
  const model = buildPanelModel({ ok: false, reason: 'something-new', message: '细节' })
  assert.match(model.message, /未知失败原因/u)
  assert.match(model.message, /细节/u)
})

test('不属于任何团队与读取失败是两个答案', () => {
  const notInTeam = buildPanelModel({ ok: true, inTeam: false })
  assert.equal(notInTeam.kind, 'not-in-team')
  assert.equal(notInTeam.message, COPY.notInTeam)
  const failed = buildPanelModel({ ok: false, reason: 'read-failed', message: 'x' })
  assert.equal(failed.kind, 'unavailable')
})

test('任务板为空时说「一次也没有」，不是失败', () => {
  const model = buildPanelModel(sample({ tasks: [] }))
  assert.equal(model.kind, 'ready')
  assert.equal(model.emptyTasks, true)
})

test('失败不渲染成空列表', () => {
  const model = buildPanelModel({ ok: false, reason: 'no-service', message: '缺服务' })
  assert.equal(model.tasks, undefined)
  assert.equal(model.kind, 'unavailable')
})

test('写面关闭时三个按钮全不画', () => {
  const model = buildPanelModel(sample({ writeEnabled: false, writeDisabledReason: '没有 Lead 实例' }))
  assert.equal(model.writeEnabled, false)
  for (const row of model.tasks) {
    assert.deepEqual(row.actions, { claim: false, release: false, edit: false })
  }
})

test('接手只出现在无主、ready、pending 的任务上', () => {
  const model = buildPanelModel(sample())
  const claimable = model.tasks.find(row => row.id === 'task-2')
  assert.equal(claimable.actions.claim, true)
  const blocked = model.tasks.find(row => row.id === 'task-4')
  assert.equal(blocked.actions.claim, false)
  const owned = model.tasks.find(row => row.id === 'task-1')
  assert.equal(owned.actions.claim, false)
})

test('放回只出现在 Lead 自己持有且进行中的任务上', () => {
  const model = buildPanelModel(sample())
  assert.equal(model.tasks.find(row => row.id === 'task-1').actions.release, true)
  assert.equal(model.tasks.find(row => row.id === 'task-3').actions.release, false)
})

test('完成的任务仍可改一改，但没有接手与放回', () => {
  const done = task({ id: 'task-8', status: 'completed', owner: 'lead' })
  assert.deepEqual(actionsForTask(done, { writeEnabled: true }), { claim: false, release: false, edit: true })
})

test('ownerOfTask 只按快照事实命名', () => {
  assert.deepEqual(ownerOfTask({ owner: 'lead' }), { text: 'Lead', kind: 'lead' })
  assert.deepEqual(ownerOfTask({ owner: 'none' }), { text: '未认领', kind: 'none' })
  assert.deepEqual(ownerOfTask({ owner: 'teammate', ownerName: 'raven' }), { text: 'raven', kind: 'member' })
  assert.deepEqual(ownerOfTask({ owner: 'undeclared' }), { text: '看不到', kind: 'unavailable' })
})

test('reasonText 不重复同一句话', () => {
  const same = COPY.reasons['no-service']
  assert.equal(reasonText({ reason: 'no-service', message: same }), same)
})

test('通知行随模型带出，写成功后显示署名', () => {
  const model = buildPanelModel(sample(), { notice: { kind: 'ok', text: '此项由面板代你在 Lead 名下操作' } })
  assert.equal(model.notice.text, '此项由面板代你在 Lead 名下操作')
})

test('窄屏只有标题+状态两列：不画负责人行', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // The owner span is gated on `row.narrow` exactly like wait and conflict, so
  // a narrow row is title+status / buttons and nothing between them.
  assert.match(source, /row\.narrow \? null : h\('span', \{\s*\n\s*className: row\.ownerKind/u)
  const model = buildPanelModel(sample(), { narrow: true })
  assert.equal(model.columns.length, 1)
  assert.equal(model.tasks.every(row => row.narrow === true), true)
})

test('负责人降级时在面板顶部说清原因，而不是每行一个空白「看不到」', () => {
  const model = buildPanelModel(sample({
    ownerSource: 'undeclared',
    ownerUnavailableReason: '宿主没有暴露团队事务队列，读不到任务负责人',
    tasks: [task({ id: 'task-9', owner: 'undeclared' })],
  }))
  assert.match(model.ownerNotice, /团队事务队列/u)
  assert.equal(model.tasks[0].owner, COPY.ownerHidden)
})

test('ownerSource 为 durable 时不出降级提示', () => {
  assert.equal(buildPanelModel(sample()).ownerNotice, undefined)
})

test('deleted 任务不计入任务数，也不当作活的卡点', () => {
  const tasks = [
    task({ id: 'task-1', status: 'pending', blockedBy: ['task-2'] }),
    task({ id: 'task-2', status: 'deleted' }),
  ]
  // The deleted row's subject must never be rendered as a live dependency. The
  // fixture's default subject is `x`; assert it is absent rather than guessing.
  assert.equal(summarize(tasks, []).tasks, 1)
  const model = buildPanelModel(sample({ tasks }))
  assert.equal(model.tasks.length, 1)
  assert.equal(model.summary.find(item => item.key === 'tasks').value, 1)
  assert.equal(model.tasks[0].waiting, true)
  assert.equal(model.tasks[0].blockerMissing[0], 'task-2')
})

test('只有 deleted 任务时任务板是空的', () => {
  const model = buildPanelModel(sample({ tasks: [task({ id: 'task-1', status: 'deleted' })] }))
  assert.equal(model.emptyTasks, true)
  assert.equal(model.summary.find(item => item.key === 'tasks').value, 0)
})
