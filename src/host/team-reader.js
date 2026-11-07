/**
 * Host half: read one session's team as a drawable snapshot.
 *
 * Why this file exists at all: the browser cannot reach `agentTeams` — the
 * service exposes no `@Remote`, and its every method takes a live Agent
 * instance as the caller. So the panel gets its data over a route this plugin
 * owns, and this file is the reader behind that route.
 *
 * Three rules taken from the host contracts:
 *
 *   1. The snapshot is cut from the durable `agentTeam` projection
 *      (`sessionProjections.snapshot`), so it is the same value the team domain
 *      publishes to every client, cut at one `asOfSeq`.
 *   2. The client projection omits the Lead's owner name on Lead-held tasks and
 *      carries no `ownerId` at all. The snapshot therefore reports `owner` as
 *      `'lead' | 'teammate' | 'none'` recovered from the Team service's own
 *      transaction queue, and says `undeclared` when even that read is refused
 *      — it never guesses.
 *   3. Anything that cannot be read is a named failure, never an empty list.
 *      `failure(reason, message)` carries the reason the panel renders.
 *
 * Message text is never read here. `teamMessageSnapshot.content` stays in the
 * Lead's log; only roster and task fields leave this module.
 */
import { failure } from '../contract.js'

/** The projection key owned by `@deepseek-ai/dsh-experimental-agent-team`. */
export const TEAM_PROJECTION_KEY = 'agentTeam'

/**
 * Name one task's owner from the durable task snapshot.
 * The Lead owns a task when `ownerId` is the Team id (which is the Lead's own
 * session id); a teammate owns it when the roster has that id.
 * @param {object|undefined} task durable task snapshot
 * @param {string} teamId Team id (= Lead session id)
 * @param {Map<string, object>} memberById durable roster rows by id
 * @returns {{ owner: string, ownerName?: string }}
 */
export function ownerOf(task, teamId, memberById) {
  const ownerId = task && task.ownerId
  if (typeof ownerId !== 'string' || ownerId.length === 0) return { owner: 'none' }
  if (ownerId === teamId) return { owner: 'lead', ownerName: 'lead' }
  const member = memberById.get(ownerId)
  if (member === undefined) {
    // The durable roster lost the row but the task still names it. Naming the
    // id is honest; calling it "unclaimed" would not be.
    return { owner: 'teammate', ownerName: ownerId }
  }
  return { owner: 'teammate', ownerName: member.name }
}

/**
 * Turn one client-projection task into a snapshot task.
 * @param {object} task task view from the `agentTeam` projection
 * @param {object|undefined} durable matching durable task snapshot
 * @param {{ owner: string, ownerName?: string }} owner resolved owner
 * @returns {object} snapshot task
 */
export function snapshotTask(task, durable, owner) {
  return {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: durable !== undefined && typeof durable.description === 'string'
      ? durable.description
      : '',
    status: task.status,
    blockedBy: Array.isArray(task.blockedBy) ? [...task.blockedBy] : [],
    writeScopes: Array.isArray(task.writeScopes) ? [...task.writeScopes] : [],
    ready: task.ready === true,
    writeScopeWarnings: Array.isArray(task.writeScopeWarnings) ? [...task.writeScopeWarnings] : [],
    owner: owner.owner,
    ...owner.ownerName === undefined ? {} : { ownerName: owner.ownerName },
  }
}

/**
 * Runtime status for one roster row.
 * `phase` is durable; `running`/`inactive` are runtime and only readable while
 * the member's Agent is live. A row without a live Agent reports `unknown`
 * with `statusLive: false`, which is a different fact from `inactive`.
 * @param {object|undefined} agent live Agent instance
 * @param {string} phase durable roster phase
 * @param {string} [error] durable failure text
 * @returns {{ status: string, statusLive: boolean, diagnostics: string[] }}
 */
export function runtimeStatus(agent, phase, error) {
  if (phase === 'provisioning') return { status: 'provisioning', statusLive: false, diagnostics: [] }
  if (phase === 'failed') {
    return {
      status: 'failed',
      statusLive: false,
      diagnostics: typeof error === 'string' && error.length > 0 ? [error] : [],
    }
  }
  if (agent === undefined || agent === null) return { status: 'unknown', statusLive: false, diagnostics: [] }
  return {
    status: agent.status === 'running' ? 'running' : 'inactive',
    statusLive: true,
    diagnostics: [],
  }
}

/**
 * Resolve the live Agent that may act for one session.
 * @param {object} ctx Host context exposing `agents`
 * @param {string} sessionId session whose Agent is wanted
 * @returns {object|undefined}
 */
export function liveAgentOf(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
  return agents.get(sessionId)
}

/**
 * Map one session whose team is wanted to the session that holds the team.
 *
 * A teammate's session is a subagent of the Lead: the team lives in the Lead's
 * log, while the teammate's own Agent stays a valid caller. So the caller is:
 *   - the live Agent of `sessionId`, when there is one;
 *   - else the live Agent of `header.parentSession`.
 * This is identity lookup, not an authorization decision: authorization is
 * `agentTeams.membership`'s job and runs on whatever Agent is handed to it.
 * @param {object} ctx Host context exposing `agents` and `sessions`
 * @param {string} sessionId
 * @returns {{ agent?: object, leadSessionId?: string }}
 */
export function resolveCaller(ctx, sessionId) {
  const agent = liveAgentOf(ctx, sessionId)
  if (agent !== undefined) {
    return { agent, leadSessionId: agent.session?.header?.parentSession ?? agent.id }
  }
  const sessions = ctx.get('sessions')
  const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
  const parentId = session?.header?.parentSession
  if (typeof parentId !== 'string') return {}
  const parentAgent = liveAgentOf(ctx, parentId)
  if (parentAgent === undefined) return {}
  return { agent: parentAgent, leadSessionId: parentAgent.id }
}

/**
 * Read one Team's durable state through the service's own transaction queue.
 *
 * `TeamService` keeps its journal private, and the public methods only return
 * client views. Reading the journal is what recovers `ownerId` and
 * `description`, both of which the client view drops. The read is queued
 * behind any in-flight write for that Lead (so it is never torn), the result is
 * copied out, and any refusal degrades the owner to `undeclared` instead of
 * guessing.
 * @param {object} teams `agentTeams` service
 * @param {function(): object} root Lead Agent getter, called lazily
 * @returns {Promise<{ members: Map<string, object>, byId: Map<string, object>, available: boolean, reason: string }>}
 */
export async function readDurableState(teams, root) {
  /** @type {(reason: string) => { members: Map<string, object>, byId: Map<string, object>, available: boolean, reason: string }} */
  const empty = reason => ({ members: new Map(), byId: new Map(), available: false, reason })
  const journal = teams && teams.journal
  const roster = teams && teams.roster
  // "The host renamed or hid the journal" is not a refusal; it is a host this
  // plugin does not understand. Say that, rather than a bare `看不到`.
  if (journal === undefined || journal === null || typeof journal.transact !== 'function') {
    return empty('宿主没有暴露团队事务队列，读不到任务负责人')
  }
  const lead = root()
  if (lead === undefined) return empty('没有活的 Lead 实例，读不到任务负责人')
  const rootId = roster?.membership !== undefined ? String(roster.membership(lead).root.id) : String(lead.id)
  try {
    const copy = await journal.transact(rootId, () => {
      const state = journal.state(lead)
      return {
        members: (state.members ?? []).map(member => ({ ...member })),
        tasks: (state.tasks ?? []).map(task => ({ ...task })),
      }
    })
    /** @type {Map<string, object>} */
    const members = new Map()
    for (const member of copy.members) members.set(member.id, member)
    /** @type {Map<string, object>} */
    const byId = new Map()
    for (const task of copy.tasks) byId.set(task.id, task)
    return { members, byId, available: true, reason: '' }
  } catch (error) {
    return empty(`读取团队事务队列失败：${messageOf(error)}`)
  }
}

/**
 * Build the snapshot payload shared by the route and by the CLI probe.
 * @param {object} ctx Host context
 * @param {string} sessionId session whose team is wanted
 * @param {{ writeDisabledReason?: string }} [options] write-surface state to report
 * @returns {Promise<object>} snapshot payload or failure payload
 */
export async function readTeam(ctx, sessionId, options = {}) {
  const teams = ctx.get('agentTeams')
  if (teams === undefined || teams === null) {
    return failure('no-service', '当前 profile 没有启用 agentTeams 服务，团队数据无从读取')
  }
  const projections = ctx.get('sessionProjections')
  if (projections === undefined || projections === null || typeof projections.snapshot !== 'function') {
    return failure('no-service', 'sessionProjections 服务不可用，团队数据无从读取')
  }

  const resolved = resolveCaller(ctx, sessionId)
  const agent = resolved.agent
  if (agent === undefined) {
    return failure('no-agent', '该会话没有存活的 Agent（可能未加载或已归档）')
  }

  let membership
  try {
    membership = teams.tryMembership(agent)
  } catch (error) {
    return failure('read-failed', `无法解析该会话的团队身份：${messageOf(error)}`)
  }
  if (membership === undefined) {
    return { ok: true, inTeam: false }
  }

  const sessions = ctx.get('sessions')
  const leadSessionId = resolved.leadSessionId ?? String(membership.root.id)
  const lead = typeof sessions?.get === 'function' ? sessions.get(leadSessionId) : undefined
  if (lead === undefined) {
    return failure('read-failed', '找不到团队的 Lead 会话，读不到团队投影')
  }

  let snapshot
  try {
    snapshot = projections.snapshot(lead, [TEAM_PROJECTION_KEY])
  } catch (error) {
    return failure('read-failed', `读取团队投影失败：${messageOf(error)}`)
  }
  const view = snapshot.values?.[TEAM_PROJECTION_KEY]
  if (view === undefined) {
    return failure('no-service', 'agentTeam 投影没有注册，读不到团队名册与任务板')
  }
  if (typeof view.failure === 'string' && view.failure.length > 0) {
    return failure('read-failed', `团队投影进入失败态，之后每次读都会失败：${view.failure}`)
  }

  const durable = await readDurableState(teams, () => agent)
  const teamId = String(membership.id)
  const agents = ctx.get('agents')

  const members = (view.members ?? []).map((member) => {
    const isLead = member.role === 'lead'
    const live = isLead ? agent : agents?.get?.(member.id)
    // The projection normally carries `phase`; when it does not, the durable
    // roster row does. Falling back keeps a `failed` member from being drawn
    // as merely `unknown`.
    const durablePhase = durable.members.get(member.id)?.phase
    const phase = member.phase ?? durablePhase ?? 'active'
    const runtime = runtimeStatus(live, phase, member.error ?? durable.members.get(member.id)?.error)
    return {
      id: member.id,
      name: member.name,
      role: member.role,
      phase,
      lead: isLead,
      status: runtime.status,
      statusLive: runtime.statusLive,
      diagnostics: runtime.diagnostics,
      ...member.error === undefined ? {} : { error: member.error },
    }
  })

  const tasks = (view.tasks ?? []).filter(task => task.status !== 'deleted').map((task) => {
    const record = durable.byId.get(task.id)
    const owner = durable.available
      ? ownerOf(record, teamId, durable.members)
      : { owner: 'undeclared' }
    return snapshotTask(task, record, owner)
  })

  return {
    ok: true,
    inTeam: true,
    asOfSeq: typeof snapshot.asOfSeq === 'number' ? snapshot.asOfSeq : -1,
    teamId,
    role: membership.role,
    name: membership.name,
    ownerSource: durable.available ? 'durable' : 'undeclared',
    ...durable.available ? {} : { ownerUnavailableReason: durable.reason },
    members,
    tasks,
    writeEnabled: options.writeDisabledReason === undefined,
    ...options.writeDisabledReason === undefined ? {} : { writeDisabledReason: options.writeDisabledReason },
  }
}

/** Render any thrown value as one bounded line. */
export function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return String(error)
  } catch {
    return '未知错误'
  }
}
