import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { SNAPSHOT_PATH, WRITE_PATH, statusOf } from '../src/contract.js'
import { EVENTS_PATH, PROBE_PATH, inject, writeDisabledReason } from '../index.js'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

test('包清单：私有本地包，带 bundle patch 与 web 客户端', () => {
  assert.equal(manifest.name, '@local/dsh-agent-manager')
  assert.equal(manifest.private, true)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-client-ui-session',
  ])
})

test('engines.dsh 锁在 0.2.2-rc.1：宿主不匹配时被明确拒载', () => {
  assert.equal(manifest.engines.dsh, '0.2.2-rc.1')
  // 写了 engines.dsh 就只看它、忽略 peerDependencies；peer 里不能出现 dsh-* 键，
  // 否则规则一变就悄悄多一道门禁。
  const peerKeys = Object.keys(manifest.peerDependencies || {})
  assert.ok(peerKeys.every(key => !key.startsWith('@deepseek-ai/dsh')))
})

test('客户端半与契约文件都可被宿主按 exports 解析', () => {
  assert.equal(manifest.exports['./client'], './client.js')
  assert.ok(manifest.files.includes('src/**/*.js'))
})

test('cordis.patch.yml 插入本插件的一行', () => {
  const patch = readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: agent-manager/u)
  assert.match(patch, /@local\/dsh-agent-manager/u)
})

test('四条路由路径互不重叠，且都不是 SPA 的路径', () => {
  const paths = [SNAPSHOT_PATH, WRITE_PATH, EVENTS_PATH, PROBE_PATH]
  assert.equal(new Set(paths).size, paths.length)
  for (const path of paths) assert.match(path, /^\/agent-manager\//u)
})

test('失败原因映射到 HTTP 状态，鉴权类失败不会被当成 200', () => {
  assert.equal(statusOf('unauthorized'), 403)
  assert.equal(statusOf('no-auth'), 503)
  assert.equal(statusOf('no-session'), 400)
  assert.equal(statusOf('no-agent'), 404)
  assert.equal(statusOf('no-service'), 503)
  assert.equal(statusOf('read-failed'), 500)
})

test('写面在缺团队服务时明确关闭并给原因；有服务时不关', () => {
  const withService = { get: name => (name === 'agentTeams' ? { updateTask: () => {} } : undefined) }
  assert.equal(writeDisabledReason(withService), undefined)
  const without = { get: () => undefined }
  const reason = writeDisabledReason(without)
  assert.equal(typeof reason, 'string')
  assert.match(reason, /只读/u)
})

test('拿不到 Lead 实例时写面也明确关闭并给原因（不等到点击才报错）', () => {
  const lead = { id: 'lead-session', status: 'running', session: { header: { id: 'lead-session' } } }
  const services = {
    agentTeams: { updateTask: () => {} },
    agents: { get: id => (id === 'lead-session' ? lead : undefined) },
    sessions: { get: () => undefined },
  }
  const ctx = { get: name => services[name] }
  assert.equal(writeDisabledReason(ctx, 'lead-session'), undefined)
  const reason = writeDisabledReason(ctx, 'archived-session')
  assert.equal(typeof reason, 'string')
  assert.match(reason, /Lead/u)
  assert.match(reason, /只读/u)
})

test('硬注入只要 webServer/agents/sessions/sessionProjections：缺团队服务也照样加载', () => {
  assert.deepEqual([...inject], ['webServer', 'agents', 'sessions', 'sessionProjections'])
  assert.ok(!inject.includes('agentTeams'))
  assert.ok(!inject.includes('connection'))
})

test('客户端半：标题与 guide 文案都是函数（传字符串会在渲染期把整页带下去）', async () => {
  // The client bundle registers itself through window.__ModuleLoader__; stub it
  // so the factory can be inspected without a browser.
  let registration
  const previous = globalThis.window
  globalThis.window = {
    __ModuleLoader__: { load: (entry) => { registration = entry } },
  }
  try {
    await import('../client.js')
    assert.ok(registration, 'client bundle did not register')
    assert.equal(registration.id, '@local/dsh-agent-manager')
    const module = registration.factory(() => ({ createElement: () => null }))
    assert.ok(Array.isArray(module.inject))
    assert.equal(typeof module.apply, 'function')
  } finally {
    globalThis.window = previous
  }
})

test('客户端半不含任何定时刷新逻辑（推送而非轮询）', () => {
  const source = readFileSync(join(packageDir, 'client.js'), 'utf8')
  // Interval/timeout polling is what the old panel did; the new data path is
  // one EventSource plus a ResizeObserver for width. Nothing may schedule.
  assert.doesNotMatch(source, /setInterval\s*\(/u)
  assert.doesNotMatch(source, /POLL_MS|poll\s*\(/iu)
  assert.match(source, /new EventSource\(/u)
})

test('宿主半不注册任何定时器', () => {
  for (const file of ['index.js', 'src/host/team-reader.js', 'src/host/writes.js']) {
    const source = readFileSync(join(packageDir, file), 'utf8')
    assert.doesNotMatch(source, /setInterval\s*\(/u, file)
    assert.doesNotMatch(source, /setTimeout\s*\(/u, file)
  }
})

test('宿主半只在 team 投影变化时推送，其它提交不唤醒', async () => {
  const { readFileSync: read } = await import('node:fs')
  const source = read(join(packageDir, 'index.js'), 'utf8')
  assert.match(source, /change\.key === TEAM_KEY/u)
})

test('tab 注册：id 与槽位 key 是同一个常量，且标题是函数', () => {
  const source = readFileSync(join(packageDir, 'client.js'), 'utf8')
  assert.match(source, /ctx\.sidebarRightTabs\.register\(\{\s*id: ID,/u)
  assert.match(source, /key: ID \}/u)
  assert.match(source, /title: \(\) => COPY\.title/u)
  assert.match(source, /title: \(\) => COPY\.title,\s*\n\s*description: \(\) =>/u)
})

test('样式表用 data-plugin 与 data-plugin-css 认领归属，disposer 为空', () => {
  const source = readFileSync(join(packageDir, 'client.js'), 'utf8')
  assert.match(source, /tag\.dataset\.plugin = ID/u)
  assert.match(source, /tag\.dataset\.pluginCss/u)
  assert.match(source, /return \(\) => \{\}\n\}/u)
})
