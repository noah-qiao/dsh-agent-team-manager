/**
 * Panel model: the single pure function that turns one snapshot payload into
 * everything the panel draws.
 *
 * It lives apart from the React component on purpose. Every claim the panel
 * makes — a count, an owner, "看不到" plus its reason, the attribution line — is
 * decided here, in a function with no hooks, no timers and no fetch. The
 * component only lays these values out.
 *
 * Rules encoded below, straight from the spec:
 *   - Counts come from the snapshot. Nothing is estimated.
 *   - An owner is `Lead`, a member name, `未认领`, or `看不到` (never guessed).
 *   - A failure is a sentence, not an empty list. "一次也没有" and "看不到" are
 *     different answers and must render differently.
 *   - No percentage, no progress bar: the team has no progress data.
 */

/** Copy for the panel. Kept short: every line has to earn its space. */
export const COPY = Object.freeze({
  title: '团队管理',
  loading: '读取中…',
  noSession: '没有打开的会话。',
  notInTeam: '当前会话不属于任何团队。',
  unavailable: '看不到',
  retry: '重试',
  solo: '目前只有你一个人。',
  members: '成员',
  tasks: '任务',
  tasksHeld: '{n} 张',
  blocks: '卡住',
  conflicts: '冲突',
  owner: '负责',
  ownerLead: 'Lead',
  ownerNone: '未认领',
  ownerHidden: '看不到',
  ownerHiddenReasonFallback: '读不到任务的负责来源',
  teammate: '队友',
  waitingOn: '在等',
  waitingOnNone: '没有前置',
  blocked: '卡住',
  conflictLine: '和 {ids} 可能改到同一个地方',
  claim: '接手',
  release: '放回',
  edit: '改一改',
  save: '保存',
  cancel: '取消',
  subjectLabel: '标题',
  descriptionLabel: '描述',
  readOnly: '只读',
  statuses: {
    pending: '排队中',
    in_progress: '正在做',
    completed: '做完了',
    running: '在跑',
    inactive: '空闲',
    provisioning: '准备中',
    failed: '出错了',
    unknown: '看不到运行状态',
  },
  reasons: {
    'no-auth': '鉴权服务不可用，宿主拒绝了这次读取',
    unauthorized: '这次读取没有通过宿主的鉴权',
    'no-session': '没有给出会话，不知道要看哪个团队',
    'no-agent': '这个会话没有存活的 Agent，读不到团队',
    'no-service': '当前 profile 缺少团队服务，读不到团队',
    'read-failed': '读取团队失败了',
  },
})

/** Status columns; `deleted` never reaches a snapshot. */
const STATUSES = ['pending', 'in_progress', 'completed']

/**
 * Resolve the failure sentence for a payload.
 * @param {object} payload failure payload `{ ok:false, reason, message }`
 * @returns {string} one sentence naming the cause
 */
export function reasonText(payload) {
  const base = COPY.reasons[payload.reason] || `未知失败原因「${String(payload.reason)}」`
  const detail = typeof payload.message === 'string' && payload.message.length > 0 ? payload.message : ''
  if (detail.length === 0) return base
  if (detail === base) return base
  return `${base}。${detail}`
}

/**
 * Read the display name of one task's owner in a way that never invents one.
 * @param {object} task snapshot task
 * @returns {{ text: string, kind: 'lead'|'none'|'member'|'unavailable' }}
 */
export function ownerOfTask(task) {
  if (task.owner === 'lead') return { text: COPY.ownerLead, kind: 'lead' }
  if (task.owner === 'none') return { text: COPY.ownerNone, kind: 'none' }
  if (task.owner === 'teammate') {
    return { text: typeof task.ownerName === 'string' && task.ownerName.length > 0 ? task.ownerName : COPY.ownerHidden, kind: 'member' }
  }
  return { text: COPY.ownerHidden, kind: 'unavailable' }
}

/**
 * Resolve "在等什么" into readable parts.
 * A blocker id that is not in the snapshot is left as the id and marked, rather
 * than silently dropped or reworded.
 * @param {object} task snapshot task
 * @param {Map<string, object>} taskById tasks in this snapshot
 * @returns {{ text: string, waiting: boolean, missing: string[] }}
 */
export function waitOfTask(task, taskById) {
  const ids = Array.isArray(task.blockedBy) ? task.blockedBy : []
  if (ids.length === 0) return { text: COPY.waitingOnNone, waiting: false, missing: [] }
  const open = []
  const missing = []
  // A blocker the snapshot does not carry, or carries only as a deleted
  // tombstone, is not a live dependency: keep the bare id and mark it, never
  // render the deleted task's subject as something still blocking.
  const unusable = (blocker) => blocker === undefined || blocker.status === 'deleted'
  for (const id of ids) {
    const blocker = taskById.get(id)
    if (unusable(blocker)) {
      missing.push(id)
      open.push(id)
      continue
    }
    if (blocker.status !== 'completed') open.push(blocker.subject || id)
  }
  const all = ids.map((id) => {
    const blocker = taskById.get(id)
    return unusable(blocker) ? id : blocker.subject || id
  })
  const waiting = open.length > 0
  return { text: `${COPY.waitingOn} ${all.join('、')}`, waiting, missing }
}

/**
 * One line describing the write-scope warnings the Host reported.
 * The Host computes them; this only renders them, so the two can never disagree
 * about what overlaps.
 * @param {object} task snapshot task
 * @returns {string|undefined}
 */
export function conflictOfTask(task) {
  const warnings = Array.isArray(task.writeScopeWarnings) ? task.writeScopeWarnings : []
  if (warnings.length === 0) return undefined
  const ids = warnings
    .map(warning => {
      const match = /^write scopes overlap with (.+)$/u.exec(String(warning))
      return match === null ? String(warning) : match[1]
    })
  return COPY.conflictLine.replace('{ids}', ids.join('、'))
}

/**
 * Which write buttons one task may offer.
 *
 * `claim` is offered on an unowned, ready, pending task — exactly the state the
 * service will accept. `release` is offered on a task the Lead holds and that is
 * in progress. `edit` is offered on every task still on the board: the service
 * authorizes the Lead to edit any task, and completed tasks stay editable so a
 * completed requirement can be reworded. A button the service would reject is
 * never drawn: a button that always fails is a lie about the panel's reach.
 * @param {object} task snapshot task
 * @param {object} options
 * @param {boolean} options.writeEnabled whether the write route can act
 * @returns {{ claim: boolean, release: boolean, edit: boolean }}
 */
export function actionsForTask(task, options) {
  if (options.writeEnabled !== true) return { claim: false, release: false, edit: false }
  if (task.status === 'completed') return { claim: false, release: false, edit: true }
  return {
    claim: task.status === 'pending' && task.ready === true && task.owner === 'none',
    release: task.status === 'in_progress' && task.owner === 'lead',
    edit: true,
  }
}

/**
 * Summary numbers, all counted from the snapshot.
 * @param {object[]} tasks snapshot tasks
 * @param {object[]} members snapshot members
 * @returns {{ members: number, tasks: number, blocked: number, conflicts: number }}
 */
export function summarize(tasks, members) {
  let blocked = 0
  let conflicts = 0
  const live = tasks.filter(task => task.status !== 'deleted')
  for (const task of live) {
    if (task.status === 'completed') continue
    if (conflictOfTask(task) !== undefined) conflicts += 1
    const waiting = (task.blockedBy || []).length > 0 && task.status !== 'in_progress'
    const unready = task.status === 'pending' && task.ready !== true
    if (waiting || unready) blocked += 1
  }
  return { members: members.length, tasks: live.length, blocked, conflicts }
}

/**
 * Turn one snapshot payload into the whole panel model.
 * @param {object} payload snapshot or failure payload
 * @param {object} [options]
 * @param {boolean} [options.narrow] render capability: narrow panes drop to two columns
 * @param {string} [options.notice] a transient line (write result) to show above the tasks
 * @returns {object} view model
 */
export function buildPanelModel(payload, options = {}) {
  if (payload === undefined || payload === null) {
    return { kind: 'loading', title: COPY.title }
  }
  if (payload.ok === false) {
    return {
      kind: 'unavailable',
      title: COPY.title,
      reason: payload.reason,
      message: reasonText(payload),
    }
  }
  if (payload.inTeam === false) {
    return { kind: 'not-in-team', title: COPY.title, message: COPY.notInTeam }
  }
  if (payload.ok === true && payload.ownerSource === 'undeclared') {
    // The owner column is degraded. Say why once, above the board, instead of
    // repeating a bare 看不到 on every row.
    payload = { ...payload, ownerNotice: payload.ownerUnavailableReason || COPY.ownerHiddenReasonFallback }
  }

  const members = Array.isArray(payload.members) ? payload.members : []
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : []
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const narrow = options.narrow === true

  const memberRows = members.map((member) => {
    // Counted from the task rows themselves: a Lead-held task names `lead`, a
    // teammate-held one names that teammate, and an unowned one names nobody.
    const held = tasks.filter((task) => {
      if (member.lead) return task.owner === 'lead'
      // The name `lead` is reserved for the Lead row and can never belong to a
      // teammate row, so skipping it here cannot hide a real assignment.
      if (member.name === 'lead') return false
      return task.owner === 'teammate' && task.ownerName === member.name
    }).length
    return {
      key: member.id,
      name: member.name,
      role: member.lead ? COPY.ownerLead : COPY.teammate,
      held,
      heldText: COPY.tasksHeld.replace('{n}', String(held)),
      status: member.status,
      statusText: member.status === 'unknown' ? COPY.statuses.unknown : (COPY.statuses[member.status] || member.status),
    }
  })

  const live = tasks.filter(task => task.status !== 'deleted')
  const taskRows = live.map((task) => {
    const owner = ownerOfTask(task)
    const wait = waitOfTask(task, taskById)
    return {
      key: task.id,
      id: task.id,
      revision: task.revision,
      subject: task.subject,
      description: task.description,
      status: task.status,
      statusText: COPY.statuses[task.status] || task.status,
      owner: owner.text,
      ownerKind: owner.kind,
      waiting: wait.waiting,
      waitText: wait.text,
      blockerMissing: wait.missing,
      conflict: conflictOfTask(task),
      actions: actionsForTask(task, { writeEnabled: payload.writeEnabled === true }),
      narrow,
    }
  })

  const counts = summarize(tasks, members)

  const columns = narrow
    ? [{ key: 'tasks', title: COPY.tasks }]
    : STATUSES.map(status => ({
      key: status,
      title: COPY.statuses[status],
      rows: taskRows.filter(row => row.status === status),
    }))

  return {
    kind: 'ready',
    title: COPY.title,
    summary: [
      { key: 'members', label: COPY.members, value: counts.members },
      { key: 'tasks', label: COPY.tasks, value: counts.tasks },
      { key: 'blocked', label: COPY.blocks, value: counts.blocked },
      { key: 'conflicts', label: COPY.conflicts, value: counts.conflicts },
    ],
    members: memberRows,
    solo: members.length === 1,
    soloText: members.length === 1 ? COPY.solo : undefined,
    tasks: taskRows,
    columns,
    emptyTasks: live.length === 0,
    ownerNotice: payload.ownerNotice,
    writeEnabled: payload.writeEnabled === true,
    writeDisabledReason: payload.writeDisabledReason,
    notice: options.notice,
  }
}
