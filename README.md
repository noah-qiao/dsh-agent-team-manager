# dsh-agent-manager

右侧栏「团队管理」：把当前会话所在智能体团队的**成员与任务**放进右侧栏，并提供三条
**做错了也能改回来**的写操作——接手 / 放回 / 改一改。

## 前置条件

| 要求 | 说明 |
| --- | --- |
| dsh 版本 | `0.2.2-rc.1`，与 `package.json` 的 `engines.dsh` 完全一致。版本不符会被明确拒载，不会跑到一半再报错 |
| `agentTeams` 服务 | 由 bundle `@deepseek-ai/dsh-experimental-agent-team-profile` 提供。缺了插件仍会加载，但面板变只读 |
| `connection` 服务 | 路由鉴权用。缺了所有路由 fail-closed 返回 503，不会裸奔 |
| Node.js | 仅本地跑测试时需要（`node --test`，要求 ≥ 20） |

## 安装

本包是 `private` 的本地包，不走 npm 发布，按目录安装。

### 1. 确认目标 profile

dsh 的每个 profile 是独立的一套依赖与配置。先看清要装到哪个 profile：

```sh
echo $DSH_PROFILE        # 由 profile 启动的宿主里才有值
ls ~/.dsh/profiles/      # 否则直接看有哪些 profile
```

macOS 桌面 App 用 `desktop`；Web / headless 分别是 `web`、`headless`。

### 2. 把包装进 profile

```sh
dsh plugin --profile desktop add agent-team-manager
```

说明几点，都是容易踩的：

- **`--profile` 是必填**。`dsh plugin` 只是把参数转发给 profile 目录里的 pnpm，
  不带 profile 会直接报 `required option '--profile <name>' not specified`。
- **用绝对路径**，且是**含 `package.json` 的包根目录**。它会被写成 `link:`，
  之后改源码即生效，不需要重装。
- **不要用 `pnpm add` 手动装**，也不要手改 profile 的 `package.json`；
  用这个命令，安装与链接由它负责。

### 3. 把 bundle 选进 profile

上一步只装了包，**还要让 profile 加载它**。在 profile 的 `package.json` 里，
把包名追加到 `dsh.profile.bundles` 数组：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "@local/dsh-agent-manager"
      ]
    }
  }
}
```

本包的 `package.json` 里有 `dsh.bundle.patch → ./cordis.patch.yml`，该 patch 会插入
`id: agent-manager` 这一行，Host 半随 profile 一起加载。

> 在 dsh 内部操作时，等价做法是用 `plugin_manager` 的 `install_bundle`
> （`target` 传同一个绝对路径）。它会一并完成第 2、3 步，不需要再去碰 profile 文件。

### 4. 重启并验证

装完重启宿主，**刷新页面**，右侧栏应出现「团队管理」页签。

不依赖浏览器，用 CLI 自检（这条路由按设计不需要浏览器凭证）：

```sh
curl -s "http://<宿主地址>/agent-manager/probe?sessionId=<会话 id>"
```

正常返回与 `/agent-manager/snapshot` 同一份 JSON：`{ ok: true, inTeam: true, members: [...], tasks: [...] }`。
失败返回 `{ ok: false, reason, message }`，`reason` 对照下表即可定位。

### 5. 升级与卸载

```sh
# 升级：源码已 link，改完重启宿主并刷新页面即可
# 卸载
dsh plugin --profile desktop remove @local/dsh-agent-manager
```

卸载后记得把包名从 `dsh.profile.bundles` 里删掉，否则 profile 会指向一个不存在的 bundle。

## 排错

先看 `reason`，再看原因是哪一种：

| `reason` | HTTP | 含义与处理 |
| --- | --- | --- |
| `no-auth` | 503 | 鉴权服务不可用。profile 里缺 `connection` |
| `unauthorized` | 403 | 凭证被拒，或写入跨站。检查 Host / Origin |
| `no-session` | 400 | 请求没带 `sessionId` |
| `no-agent` | 404 | 该会话没有活 Agent（已归档、被驱逐、从未加载）。换个活着的会话，或重启宿主 |
| `no-service` | 503 | 缺 `agentTeams` 服务。确认 `@deepseek-ai/dsh-experimental-agent-team-profile` 在 bundles 里 |
| `read-failed` | 500 / 200 | 读取或写入失败，`message` 带原始原因 |

几个常见现象：

- **页签不出现**：多半是第 3 步漏了。包装了不代表 profile 会加载它。
- **页签出现但写不了**：面板会显示 `writeDisabledReason`。两种原因——profile 没有
  `agentTeams`，或宿主进程里拿不到该会话的活 Lead 实例。`agentTeams` 的每个方法都要一个活
  `Agent` 作 caller，插件没有自己的身份，没有 Lead 就没有能署名的写手。这是设计上的降级，
  不是 bug。
- **成员状态显示「看不到运行状态」**：`running` / `inactive` 只从活 `Agent` 读得到。
  不会把「不知道」画成「空闲」。
- **点了写操作提示「别人刚改过，刷新再看看」**：并发冲突，正常行为。写操作带
  `expectedRevision` 乐观锁，不会自动重试。
- **版本不符被拒载**：宿主不是 `0.2.2-rc.1`。改 `engines.dsh` 前先确认 API 兼容。

## 为什么这样设计

三件事必须先答对，否则插件不成立：

1. **入口**由两半组成：`ctx.sidebarRightTabs.register({ id, kind, title, guide })` 注册 tab
   **类型**，`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id })` 注册**正文**。
   两处都用同一个 `id` 当 key——宿主按「在位类型的 `id`」派发 keyed 槽，写错不报错，只会静默降级成
   「这类内容还没有可用的查看方式」。
   `title` 与 `guide[].title` / `description` **必须是函数**：传字符串能注册成功，渲染期抛
   `TypeError`，被错误边界接住后整页引导消失。
2. **数据**只能由 Host 侧取。`agentTeams` 的每个方法都要一个活 `Agent` 实例作 caller，且**没有
   `@Remote`**；浏览器够不到。所以 Host 半注册自己的路由，面板通过推送流取数。
3. **写面**收敛在 `agentTeams.updateTask(caller, { taskId, expectedRevision, action })` 一个 CAS
   入口。每次写都带上一次读到的 `revision`；后到者拿到 `TEAM_TASK_STALE_REVISION`，面板直说
   「别人刚改过，刷新再看看」，不吞、不自动重试。署名是 **Lead**，界面上明说
   「此项由面板代你在 Lead 名下操作」。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：四条路由（快照 / 推送 / 写 / CLI 探测）；前三条要鉴权，写路由另加同源与请求体上限，探测路由按设计不要凭证 |
| `src/host/team-reader.js` | 把 `agentTeam` 投影读成可画的快照；owner 与运行态各按事实命名 |
| `src/host/writes.js` | 三条写的校验与 CAS 调用；错误码翻成句子 |
| `src/contract.js` | 前后两半共用的契约：`reason` 枚举、路径、署名与 stale 文案 |
| `src/panel-model.js` | 纯函数：一份快照 → 面板全部可画内容（测试断言的就是它） |
| `client.js` | Client 半：tab 类型 + 正文组件、样式表、`EventSource` 订阅 |
| `cordis.patch.yml` | 插入本插件的一行 |

## 路由

| 路径 | 鉴权 | 用途 |
| --- | --- | --- |
| `GET /agent-manager/snapshot?sessionId=` | 要浏览器凭证 | 一次性读快照 |
| `GET /agent-manager/events?sessionId=` | 要浏览器凭证 | SSE 推送：首帧是全量快照，之后随 `agentTeam` 变更推送 |
| `POST /agent-manager/write` | 要凭证 + 同源 + 请求体 ≤ 16 KiB | 接手 / 放回 / 改一改 |
| `GET /agent-manager/probe?sessionId=` | **不要** | CLI 自检：同一份快照，供干净会话里 curl。只读，无写能力 |

失败一律返回 `{ ok: false, reason, message }`，`reason` 取六值：
`no-auth` / `unauthorized` / `no-session` / `no-agent` / `no-service` / `read-failed`。
面板渲染成「看不到 + 一句说清原因的话」，绝不渲染成空列表。

## 只画拿得到的

- `agentTeam` 客户端投影里 Lead 持有的任务**丢了 `ownerName`**，也没有 `ownerId`；Host 半读 Team 的
  事务队列补回 owner，见 `docs/adr/0001-read-team-journal-for-owners.md`。补不到时写 `看不到`。
- 成员的 `running` / `inactive` 不属于团队投影：只从活 `Agent` 读；读不到写「看不到运行状态」，
  不把「不知道」画成「空闲」。
- 没有进度条、没有百分比、没有实时大屏：团队没有进度数据。
- 消息原文永不进快照、永不上屏。

## 写面降级

两种情况下快照带 `writeEnabled: false` 与 `writeDisabledReason`，面板变成只读并说明原因——
不留一个点了没反应的按钮：

1. profile 里没有 `agentTeams` 服务；
2. 宿主进程里拿不到这个会话的活 Lead 实例（`agentTeams` 每个方法都要活 `Agent` 作 caller，
   插件没有自己的身份，没有 Lead 就没有能署名的写手）。

## 本地开发

```sh
node --test test/*.test.js    # 102 条：清单 / 契约 / 路由 / 读快照 / 写操作
```

测试不需要浏览器，也不需要运行中的宿主。

## 已知边界

- 写面只以 Lead 名义操作：在团队成员的会话里打开面板，读没问题，但写会被拒。
- 三条写之间的状态前提由 Team 服务判定（`claim` 要无主 + `pending` + 前置全完成；`release` 要
  `in_progress`），面板只画服务会接受的那一颗按钮。
- `reassign` / `complete` / `interrupt` 不进 v1：前者原值不可回滚，中者关掉即从可接清单消失且
  面板没有重开写面，后者「停住」不等于「停下」。
