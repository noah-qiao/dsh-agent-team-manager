# Glossary: agent-team-manager

The DSH plugin `@local/dsh-agent-manager` lives in this directory. It owns the
right-sidebar tab that shows the current session's agent team and offers three
undoable writes. Terms below are this context's; the vocabulary they rest on
(入口 / 面板 / 观测面 / 写面 / 不可得) is defined in
`../agent-team-panel/GLOSSARY.md` and is not repeated here.

## 快照 (snapshot)

The one value the panel draws, cut from the durable `agentTeam` projection at a
single `asOfSeq`. A snapshot is not a live view of services: it is a copy of
what the Team domain published, plus the two fields the client projection drops
(task owner, task description) recovered from the Team's own transaction queue.

_Avoid_: 数据、状态、live data

## 署名 (attribution)

The fact that a panel write was performed by the Host's Lead Agent, not by the
browser user. The Host cannot sign as the person, so every successful write
answers with `此项由面板代你在 Lead 名下操作` and the panel prints it. 署名 is a
statement of fact, not a disclaimer.

_Avoid_: 提示、免责声明、warning

## 写面降级 (write degradation)

When the Host cannot produce a live Lead Agent, the panel turns read-only and
says why (`writeEnabled: false` + `writeDisabledReason`). It never draws a
button whose click cannot work. 降级 is decided by the Host, not by the client.

_Avoid_: 禁用、只读模式

## 推送流 (push stream)

The panel's only data path: one `EventSource` against `/agent-manager/events`,
whose first frame is a full snapshot and whose later frames follow `agentTeam`
projection changes. Reconnection is the browser's own retry logic; the panel
holds no timer. A stream that drops replaces the view with a named failure
rather than keeping older numbers on screen.

_Avoid_: 轮询、刷新、实时

## 不可得 vs 没有 (unavailable vs none)

`不可得` means the field exists but this read could not obtain it — rendered as
`看不到` plus a reason. `没有` means the read succeeded and the value is empty —
rendered as `一次也没有` / `未认领`. The two never collapse into one answer.
