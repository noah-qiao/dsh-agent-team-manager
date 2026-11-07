/**
 * Shared wire contract between the Host half and the Client half.
 *
 * Three things live here and nowhere else, because both halves must agree on
 * them byte for byte:
 *
 *   1. The team snapshot — what the panel is allowed to draw. It is derived from
 *      the durable `agentTeam` projection plus the runtime member status, and it
 *      never carries message text (privacy hard rule).
 *   2. The write request / write response — the three v1 operations.
 *   3. The closed `reason` enum — one value per honest failure, rendered as
 *      "看不到 + why" instead of an empty list.
 *
 * No imports: this file is loaded by the Host process (Node) and the browser
 * bundle alike.
 */

/** Closed failure reasons. Every failure path answers with exactly one. */
export const REASONS = Object.freeze([
  /** The request carried no verifiable browser credential. */
  'no-auth',
  /** A credential was presented and rejected (Host/Origin fence or bad token). */
  'unauthorized',
  /** The caller did not name a session. */
  'no-session',
  /** The session named has no live Agent (archived, evicted, never loaded). */
  'no-agent',
  /** A Host service this panel needs is missing from the profile. */
  'no-service',
  /** A read started and failed. The Host cannot tell the user anything more specific than that. */
  'read-failed',
])

/** The only three writes v1 offers. `edit` carries subject and/or description. */
export const WRITE_ACTIONS = Object.freeze(['claim', 'release', 'edit'])

/** `TeamError` code raised when someone else advanced the task first. */
export const STALE_REVISION_CODE = 'TEAM_TASK_STALE_REVISION'

/** Upper bound on one write request body, in bytes. */
export const MAX_WRITE_BODY_BYTES = 16 * 1024

/** Host routes owned by this plugin. */
export const SNAPSHOT_PATH = '/agent-manager/snapshot'
export const WRITE_PATH = '/agent-manager/write'

/** Map a Host-side failure reason to the HTTP status the route answers with. */
export function statusOf(reason) {
  switch (reason) {
    case 'no-auth':
      return 503
    case 'unauthorized':
      return 403
    case 'no-session':
      return 400
    case 'no-agent':
      return 404
    case 'no-service':
      return 503
    default:
      return 500
  }
}

/**
 * Build one failure payload. The `message` is what the panel shows verbatim;
 * it must name the actual cause, never a generic "failed".
 * `write === true` marks a write route answer, whose success disclaims whose
 * name the change was made under.
 */
export function failure(reason, message, write = false) {
  return write
    ? /** @type {{ ok: false, reason: string, message: string, write: true }} */ ({ ok: false, reason, message, write: true })
    : /** @type {{ ok: false, reason: string, message: string }} */ ({ ok: false, reason, message })
}

/**
 * The attribution line shown after every successful write. It states the fact:
 * the Host acted as the Lead Agent, not as the browser user.
 */
export const ATTRIBUTION = '此项由面板代你在 Lead 名下操作'

/** The sentence a stale revision is rendered as. Never swallowed, never retried. */
export const STALE_MESSAGE = '别人刚改过，刷新再看看'

/**
 * Snapshot member row.
 * @typedef {object} SnapshotMember
 * @property {string} id      session id of the member
 * @property {string} name    model-facing name; `lead` for the Lead
 * @property {'lead'|'teammate'} role
 * @property {'provisioning'|'active'|'failed'} phase durable roster phase
 * @property {boolean} lead   true for the Lead row (identity, not a guess)
 * @property {string} status  runtime status, `'unknown'` when no Agent instance is live
 * @property {boolean} statusLive whether `status` was read from a live Agent
 * @property {string[]} diagnostics
 * @property {string} [error] durable failure text for a failed member
 */

/**
 * Snapshot task row. `owner` is named from the task's own assignment only:
 * `lead` when the durable owner is the Lead, `none` when nobody holds it.
 * The client projection omits the Lead's owner name; the Host recovers it from
 * the durable snapshot before dropping the id.
 * @typedef {object} SnapshotTask
 * @property {string} id
 * @property {number} revision
 * @property {string} subject
 * @property {string} description
 * @property {'pending'|'in_progress'|'completed'} status
 * @property {string[]} blockedBy   task ids this task waits on
 * @property {string[]} writeScopes
 * @property {boolean} ready
 * @property {string[]} writeScopeWarnings
 * @property {'lead'|'teammate'|'none'|'undeclared'} owner  `undeclared` = the Host could not read the durable owner; never guess
 * @property {string} [ownerName]
 */

/**
 * Full snapshot payload for `{ ok: true, inTeam: true }`.
 * @typedef {object} SnapshotPayload
 * @property {true} ok
 * @property {true} inTeam
 * @property {number} asOfSeq    Session seq the team projection was cut at
 * @property {string} teamId
 * @property {'lead'|'teammate'} role
 * @property {string} name
 * @property {SnapshotMember[]} members
 * @property {SnapshotTask[]} tasks
 * @property {'durable'|'undeclared'} ownerSource which read produced the owner field
 * @property {boolean} writeEnabled whether the write routes can act at all
 * @property {string} [writeDisabledReason] why writes are off, when off
 */
