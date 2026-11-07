# ADR-0001: Read the Team journal for task owners, and say `undeclared` when refused

Status: accepted (2026-11-06)

## Context

`TeamTaskView` — the value the `agentTeam` projection hands to clients — has no
`ownerId`, and `ownerName` is left `undefined` when the Lead holds the task
(`@deepseek-ai/dsh-experimental-agent-team/lib/types/task-view.js:31-35`).
The panel must show `Lead` on a Lead-held task and `未认领` on an unowned one
(spec user stories 7–8), and it must not infer either.

`TeamService` keeps its journal private: `journal`, `roster` and `tasks` are
instance fields that are not part of any `@Remote` surface.

## Decision

The Host half reads the durable task snapshots through the service's own
transaction queue (`teams.journal.transact(rootId, () => copy(teams.journal.state(lead)))`),
where `ownerId` still exists and maps to the Lead's session id.

The read is:
- queued behind any in-flight write for that Lead, so it is never torn;
- copied out, so nothing is retained;
- **fail-open into honesty**: any failure degrades every task's owner to
  `undeclared`, and the snapshot carries `ownerUnavailableReason` with the
  actual cause (queue absent, no live Lead, read threw). The panel prints one
  notice above the board rather than a bare `看不到` on every row.
  `ownerSource` states which read produced the answer.

## Consequences

- Lead-held and unowned tasks stay distinguishable, which the spec requires.
- The read reaches a private field. A future host version that renames or hides
  `journal` degrades the owner column to `看不到`; it never fabricates an owner
  and never turns the whole panel into a failure.
- The alternative — extending the projection — is a host change, not a plugin
  change, and is out of scope.

## Alternatives rejected

- **`listTasks` / `listMembers` calls**: they return the same
  owner-stripped `TeamTaskView`.
- **Inferring from `writeScopeWarnings` or status**: both are heuristics; the
  spec forbids inference and requires a visible `undeclared` instead.
