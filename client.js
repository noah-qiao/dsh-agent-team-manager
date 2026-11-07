/**
 * @local/dsh-agent-manager — Client half.
 *
 * One right-sidebar tab type. Its `id` is also the body's slot key: the host
 * dispatches keyed slots by the in-band tab type's `id`, so registering the type
 * and the body under two different strings fails silently — the pane renders
 * "这类内容还没有可用的查看方式" instead of throwing.
 *
 * Two shapes the host validates only at call time, not at registration:
 *   - `title` and `guide[].title` / `guide[].description` must be FUNCTIONS.
 *     GuideBody calls `entry.title()` on every render; a string registers fine
 *     and then throws a TypeError that takes the whole guide page down.
 *   - The body's props are the whole standard kit, not just `sessionId`.
 *
 * Data arrives by push. The panel opens one `EventSource` against the Host's
 * `/agent-manager/events` stream and re-renders on every frame; the Host sends a
 * full snapshot as the first frame, so a reconnect resumes from a complete state
 * with no timer anywhere in this half. A panel that goes quiet because the
 * stream died says so instead of keeping stale numbers on screen.
 *
 * All layout decisions live in `src/panel-model.js`; this file only draws them.
 */
import { WRITE_PATH } from './src/contract.js'
import { COPY, buildPanelModel } from './src/panel-model.js'

const ID = '@local/dsh-agent-manager'
const KIND = 'agent-team-manager'
const EVENTS_ENDPOINT = '/agent-manager/events'

/** Below this width the status columns collapse into one list. */
const NARROW_PX = 380

const STYLE = [
  '.dsam-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.dsam-section{overflow:auto;min-height:0}',
  '.dsam-summary{display:flex;flex-wrap:wrap;gap:16px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.dsam-summary b{font-weight:600;font-size:15px;color:var(--dsw-alias-label-primary);margin-right:3px}',
  '.dsam-summary .conflict b{color:var(--dsw-alias-state-warn-primary)}',
  '.dsam-head{display:flex;align-items:center;gap:8px;padding:8px 12px 4px;font-size:11px;letter-spacing:.04em;color:var(--dsw-alias-label-secondary)}',
  '.dsam-tag{font-size:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px;color:var(--dsw-alias-label-secondary)}',
  '.dsam-row{padding:5px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
  '.dsam-row:last-child{border-bottom:none}',
  '.dsam-main{display:flex;align-items:baseline;gap:8px}',
  '.dsam-subject{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsam-status{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.dsam-meta{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsam-warn{display:block;font-size:11px;color:var(--dsw-alias-state-warn-primary);margin-top:2px}',
  '.dsam-owner-none{color:var(--dsw-alias-state-warn-primary)}',
  '.dsam-actions{display:flex;gap:6px;margin-top:4px}',
  '.dsam-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:1px 8px;font-size:11px;cursor:pointer}',
  '.dsam-btn:hover:enabled{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
  '.dsam-btn:disabled{opacity:.45;cursor:default}',
  '.dsam-body{flex:1;overflow:auto;min-height:0}',
  '.dsam-notice{padding:6px 12px;font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
  '.dsam-notice-ok{color:var(--dsw-alias-state-success-primary)}',
  '.dsam-notice-warn{color:var(--dsw-alias-state-warn-primary)}',
  '.dsam-err{padding:8px 12px;font-size:12px;color:var(--dsw-alias-state-warn-primary)}',
  '.dsam-note{padding:8px 12px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
  '.dsam-form{padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
  '.dsam-input,.dsam-textarea{width:100%;box-sizing:border-box;background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 6px;font:inherit;font-size:12px;margin-bottom:4px}',
  '.dsam-textarea{min-height:56px;resize:vertical}',
].join('\n')

/** Identity of the stylesheet this bundle injects. */
const STYLE_TAG = 'data-dsam-css'

/**
 * Inject the panel stylesheet once per document.
 *
 * The sheet belongs to the document, not to the fiber, so the disposer is
 * empty by contract. It still claims its own tag through `data-plugin` and
 * `data-plugin-css`: the host's `claimStyles` adopts any untagged `<style>` into
 * whatever module happened to be loading, and removal then deletes the sheet
 * under a plugin that never owned it.
 * @returns {() => void} an empty disposer, as the host expects
 */
export function installStyles(doc) {
  if (doc === null || doc === undefined) return () => {}
  const existing = doc.querySelector(`style[${STYLE_TAG}]`)
  if (existing !== null) return () => {}
  const tag = doc.createElement('style')
  tag.dataset.plugin = ID
  tag.dataset.pluginCss = `${ID}/panel`
  tag.setAttribute(STYLE_TAG, '')
  tag.textContent = STYLE
  const head = doc.head || doc.documentElement
  if (head === null) return () => {}
  head.appendChild(tag)
  return () => {}
}

/** A plain tab glyph: the host falls back to a generic cube without one. */
function PanelGlyph(props) {
  const h = props.h
  return h('svg', {
    viewBox: '0 0 16 16', width: 16, height: 16,
    className: props && props.className,
    'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
  },
  h('rect', { x: 1.6, y: 2.4, width: 12.8, height: 11.2, rx: 2.2 }),
  h('path', { d: 'M4.6 6.2h6.8M4.6 8.6h6.8M4.6 11h3.6' }))
}

/**
 * Build the panel component bound to one React instance.
 * The host hands us the standard kit as props, so React itself has to come from
 * the bundle's module system rather than a bare import.
 * @param {object} React the host React module
 * @returns {Function} component
 */
function createPanel(React) {
  const h = React.createElement

  /**
   * Run one write against the Host route.
   * The revision sent is the one the row was drawn from: if someone else moved
   * the task meanwhile, the Host answers `stale` and the panel says so instead
   * of pretending the click worked.
   * @param {object} request write request
   * @returns {Promise<object>} payload
   */
  async function postWrite(request) {
    const res = await fetch(WRITE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      body: JSON.stringify(request),
    })
    let body
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    if (body === undefined || typeof body !== 'object') {
      return { ok: false, reason: 'read-failed', message: `写入路由返回了无法解析的响应（HTTP ${res.status}）`, write: true }
    }
    return body
  }

  return function AgentManagerPanel(props) {
    const sessionId = props && props.sessionId
    const useSession = props && props.useSession
    const rootRef = React.useRef(null)
    const [payload, setPayload] = React.useState(undefined)
    const [transport, setTransport] = React.useState({ state: 'connecting' })
    const [notice, setNotice] = React.useState(undefined)
    const [pendingKey, setPendingKey] = React.useState(undefined)
    const [editing, setEditing] = React.useState(undefined)
    const [narrow, setNarrow] = React.useState(false)

    // Width is the only thing here that is not pushed by the Host: the pane
    // resizes with the window, so it is an observer, not a timer.
    React.useEffect(() => {
      const node = rootRef.current
      if (node === null || typeof ResizeObserver !== 'function') return undefined
      const observer = new ResizeObserver((entries) => {
        const width = entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0
        setNarrow(width > 0 && width < NARROW_PX)
      })
      observer.observe(node)
      return () => observer.disconnect()
    }, [])

    // A tab opened inside a teammate's conversation still shows the team that
    // teammate belongs to: the Team id is the Lead's session id, and the Host
    // reads the projection from there. `subagent.address.parentSessionId` is the
    // host's own answer to "who is my Lead"; with no parent, this session is the
    // Lead. A missing `useSession` (older kit) falls back to the session itself.
    let teamSessionId = sessionId
    if (typeof useSession === 'function') {
      const parentSessionId = useSession((snapshot) => snapshot && snapshot.subagent && snapshot.subagent.address
        ? snapshot.subagent.address.parentSessionId
        : undefined)
      if (typeof parentSessionId === 'string' && parentSessionId.length > 0) teamSessionId = parentSessionId
    }

    React.useEffect(() => {
      setPayload(undefined)
      setNotice(undefined)
      setEditing(undefined)
      if (!teamSessionId) {
        setTransport({ state: 'no-session' })
        return undefined
      }
      if (typeof EventSource !== 'function') {
        setTransport({ state: 'unsupported' })
        return undefined
      }
      setTransport({ state: 'connecting' })
      const source = new EventSource(`${EVENTS_ENDPOINT}?sessionId=${encodeURIComponent(teamSessionId)}`)
      source.onopen = () => setTransport({ state: 'open' })
      source.onmessage = (event) => {
        try {
          setPayload(JSON.parse(event.data))
        } catch {
          setPayload({ ok: false, reason: 'read-failed', message: '推送帧不是合法 JSON' })
        }
      }
      source.onerror = () => {
        // EventSource retries by itself; the panel says the stream is down so a
        // frozen screen is never mistaken for a quiet team. A failure payload
        // then replaces the view rather than leaving old numbers in place.
        setTransport({ state: 'down' })
        setPayload((prev) => (prev && prev.ok === false ? prev : {
          ok: false,
          reason: 'read-failed',
          message: '与宿主的推送连接断了，正在自动重连',
        }))
      }
      return () => {
        source.close()
      }
    }, [teamSessionId])

    const model = buildPanelModel(payload, { narrow, notice })

    const onWrite = React.useCallback(async (task, action, fields) => {
      if (pendingKey !== undefined) return
      const key = `${task.id}:${action}`
      setPendingKey(key)
      setNotice(undefined)
      try {
        const body = await postWrite({
          sessionId: teamSessionId,
          taskId: task.id,
          expectedRevision: task.revision,
          action,
          ...fields === undefined ? {} : fields,
        })
        if (body.ok === true) {
          setNotice({ kind: 'ok', text: body.attribution || '此项由面板代你在 Lead 名下操作' })
          setEditing(undefined)
        } else if (body.stale === true || body.reason === 'read-failed' && /别人刚改过/u.test(String(body.message))) {
          setNotice({ kind: 'warn', text: body.message })
        } else {
          setNotice({ kind: 'warn', text: body.message || '写入没有成功' })
        }
      } catch (error) {
        setNotice({ kind: 'warn', text: `写入请求没有送达宿主：${String(error && error.message || error)}` })
      } finally {
        setPendingKey(undefined)
      }
    }, [pendingKey, teamSessionId])

    const rows = []
    if (model.kind === 'loading' && transport.state !== 'unsupported' && transport.state !== 'no-session') {
      rows.push(h('div', { key: 'loading', className: 'dsam-note' }, COPY.loading))
    }
    if (model.kind === 'no-session' || transport.state === 'no-session') {
      rows.push(h('div', { key: 'nosession', className: 'dsam-note' }, COPY.noSession))
    }
    if (transport.state === 'unsupported') {
      rows.push(h('div', { key: 'unsupported', className: 'dsam-note' },
        '看不到：当前环境不支持宿主的推送流（EventSource 不可用）'))
    }
    if (model.kind === 'unavailable') {
      rows.push(h('div', { key: 'unavailable', className: 'dsam-err' },
        `${COPY.unavailable}：${model.message}`))
    }
    if (model.kind === 'not-in-team') {
      rows.push(h('div', { key: 'notinteam', className: 'dsam-note' }, model.message))
    }

    const body = model.kind === 'ready'
      ? [
        h('div', { key: 'summary', className: 'dsam-summary' },
          model.summary.map(item => h('span', {
            key: item.key,
            className: item.key === 'conflicts' && item.value > 0 ? 'conflict' : undefined,
          }, h('b', null, String(item.value)), item.label))),
        model.writeEnabled
          ? null
          : h('div', { key: 'readonly', className: 'dsam-note' },
            `${COPY.readOnly}：${model.writeDisabledReason || '宿主没有提供写面'}`),
        model.ownerNotice === undefined
          ? null
          : h('div', { key: 'owner-notice', className: 'dsam-note' },
            `${COPY.owner}：${COPY.ownerHidden}。${model.ownerNotice}`),
        model.notice === undefined ? null : h('div', {
          key: 'notice',
          className: `dsam-notice ${model.notice.kind === 'ok' ? 'dsam-notice-ok' : 'dsam-notice-warn'}`,
        }, model.notice.text),
        h('div', { key: 'members-head', className: 'dsam-head' }, COPY.members,
          model.solo ? h('span', { className: 'dsam-tag' }, model.soloText) : null),
        ...model.members.map(member => h('div', { key: `m-${member.key}`, className: 'dsam-row' },
          h('div', { className: 'dsam-main' },
            h('span', { className: 'dsam-subject' }, member.name),
            h('span', { className: 'dsam-status' }, member.statusText)),
          h('span', { className: 'dsam-meta' }, `${member.role} · ${member.heldText}`))),
        h('div', { key: 'tasks-head', className: 'dsam-head' }, COPY.tasks),
        model.emptyTasks
          ? h('div', { key: 'empty', className: 'dsam-note' }, '任务板是空的：一次也没有。')
          : null,
        ...(model.emptyTasks ? [] : model.columns.flatMap(column => [
          model.columns.length > 1
            ? h('div', { key: `c-${column.key}`, className: 'dsam-head' }, column.title)
            : null,
          ...((column.rows !== undefined ? column.rows : model.tasks.filter(row => row.status === column.key)) || [])
            .map(row => taskRow(row)),
        ])),
      ].filter(value => value !== null && value !== undefined)
      : []

    /**
     * Draw one task line. The button row only exists when a button is legal:
     * `actionsForTask` already decided that against the Host's own rules.
     * @param {object} row task view row
     * @returns {object} React element
     */
    function taskRow(row) {
      const actions = row.actions
      const anyAction = actions.claim || actions.release || actions.edit
      const isEditing = editing !== undefined && editing.taskId === row.key
      return h('div', { key: `t-${row.key}`, className: 'dsam-row' },
        h('div', { className: 'dsam-main' },
          h('span', { className: 'dsam-subject', title: row.subject }, row.subject),
          h('span', { className: 'dsam-status' }, row.statusText)),
        // Narrow panes are exactly two columns: title+status, then nothing but
        // the action buttons (spec #15: 收成两列「标题 + 状态」).
        row.narrow ? null : h('span', {
          className: row.ownerKind === 'none' ? 'dsam-meta dsam-owner-none'
            : row.ownerKind === 'unavailable' ? 'dsam-meta dsam-warn'
              : 'dsam-meta',
        }, `${COPY.owner}：${row.owner}`),
        row.narrow ? null : h('span', { className: row.waiting ? 'dsam-warn' : 'dsam-meta' }, row.waitText),
        row.narrow ? null : (row.conflict === undefined
          ? null
          : h('span', { className: 'dsam-warn' }, row.conflict)),
        anyAction
          ? h('div', { className: 'dsam-actions' },
            actions.claim
              ? h('button', {
                type: 'button',
                className: 'dsam-btn',
                disabled: pendingKey !== undefined,
                onClick: () => void onWrite(row, 'claim'),
              }, COPY.claim)
              : null,
            actions.release
              ? h('button', {
                type: 'button',
                className: 'dsam-btn',
                disabled: pendingKey !== undefined,
                onClick: () => void onWrite(row, 'release'),
              }, COPY.release)
              : null,
            actions.edit
              ? h('button', {
                type: 'button',
                className: 'dsam-btn',
                disabled: pendingKey !== undefined,
                onClick: () => setEditing(isEditing
                  ? undefined
                  : { taskId: row.key, subject: row.subject, description: row.description }),
              }, COPY.edit)
              : null)
          : null,
        isEditing
          ? h('div', { className: 'dsam-form' },
            h('input', {
              className: 'dsam-input',
              value: editing.subject,
              'aria-label': COPY.subjectLabel,
              onChange: (event) => setEditing({ ...editing, subject: event.target.value }),
            }),
            h('textarea', {
              className: 'dsam-textarea',
              value: editing.description,
              'aria-label': COPY.descriptionLabel,
              onChange: (event) => setEditing({ ...editing, description: event.target.value }),
            }),
            h('div', { className: 'dsam-actions' },
              h('button', {
                type: 'button',
                className: 'dsam-btn',
                disabled: pendingKey !== undefined,
                onClick: () => {
                  const fields = {}
                  if (editing.subject !== row.subject) fields.subject = editing.subject
                  if (editing.description !== row.description) fields.description = editing.description
                  if (fields.subject === undefined && fields.description === undefined) {
                    setNotice({ kind: 'warn', text: '标题和描述都没有改动' })
                    return
                  }
                  void onWrite(row, 'edit', fields)
                },
              }, COPY.save),
              h('button', {
                type: 'button',
                className: 'dsam-btn',
                onClick: () => setEditing(undefined),
              }, COPY.cancel)))
          : null,
      )
    }

    return h('div', { className: 'dsam-root', ref: rootRef },
      rows,
      body.length > 0 ? h('div', { className: 'dsam-body' }, body) : null)
  }
}

/**
 * Register the tab type and its body with the host's module loader.
 * Guarded so the file can also be loaded outside a browser (tests read the
 * factory through a stubbed loader); in a real page the loader is always there.
 */
if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) window.__ModuleLoader__.load({
  id: ID,
  factory(require) {
    const React = require('react')
    const Panel = createPanel(React)

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        const effect = (fn) => (typeof ctx.effect === 'function' ? ctx.effect(fn) : fn())

        effect(() => installStyles(typeof document === 'undefined' ? undefined : document))

        // Type first, body second, and the body's key is the type's `id`: the
        // host dispatches `sidebar.right.pane.tab` by the in-band type id.
        effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          title: () => COPY.title,
          guide: [{
            id: 'agent-team-manager',
            order: 41,
            title: () => COPY.title,
            description: () => '团队现状：成员、任务、卡点、冲突；可接手、放回、改一改',
            icon: (props) => PanelGlyph({ ...props, h: React.createElement }),
          }],
        }))

        effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, Panel)))
      },
    }
  },
})
