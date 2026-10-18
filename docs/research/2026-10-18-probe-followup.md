# R4 追加探针 —— reasoningEffort 能否在根 ctx 改写 + 会话搜索子行能否被 profile patch 覆盖

- 时间：2026-10-18
- 宿主：`D:\Program\deepseek-harness` @ `dsh-v0.2.1-rc.2`（commit `687f282e86`，只读）
- 约束：**未改**真实 profile（`C:\Users\SuSeventeen\.dsh\profiles\web\**`）、**未改** OMB 仓库、未装包、未跑 git。所有写盘都在临时目录 `D:\Program\omb-wt\_probe\r4h\`（可删）。
- 证据分级：**[实测]** 本次真跑的命令+输出；**[源码]** 只读源码行；**[推导]** 由前两者推算

---

## 0. 两句判词

**Q1（reasoningEffort 逐请求改写）：feasible at root ctx。** 根 ctx 上的 `ctx.on('agent/request', …)` 监听器**能收到**任意 agent 的该事件（payload 带被注入的 `agent`），返回的 `LlmCallConfig` 会经 `prepareCall` → `canonicalHeader` **落到 `request/header.config.reasoningEffort`**；因为根监听器注册早于每个 agent 的 model-selection 监听器，它在 waterfall 里是**最外层**，其返回值**最终生效**（实测覆盖了 agent 作用域的 `'max'`）。**但**：必须只在该模型真的声明了 effort 时设置，否则 `prepareCall` 抛 `UNSUPPORTED_REASONING_EFFORT` 直接让这一步请求失败；且每次改 effort = 改请求头 = **KV 缓存失效**。

**Q2（会话搜索子行可 patch）：可以。** bundle 层 `insert` 出来的组，其**子行可被 `- id:` patch 精确覆盖**（profile 层与 `--patch` overlay 都实测成功，`--dump-config` 零告警、diff 精确）。所以 `optional-tool-session-query` 的 `searchTimeoutMs/maxSearchResults` 与 `optional-session-query-sqlite` 的 `path/openAt` **都能从 profile 的 `cordis.patch.yml` 改**。冷建索引的实测开销合计约 **22–28s 纯 CPU**（明细见 §2.3），`searchTimeoutMs: 600000` + 持久 `path` 足以跑完一次；`openAt: startup` 会把这段搬到启动（不推荐）。

---

## Q1 —— 根 ctx 改 `reasoningEffort`：探针、链路、风险

### 1.1 事件契约与派发机制 [源码]

| 环节 | 事实 | 源 |
|---|---|---|
| 事件契约 | `'agent/request'(this: Scoped<Agent>, payload: { agent; turn; step; signal }, next)` → `Promise<LlmCallConfig>`；注释明确"**Scope-filtered dispatch：agent-scoped listeners receive only that agent**"；doc 还写了"`await next()` 拿到机器本来会用的 config，返回替换即切换；它在 assembly 与 `step/start` 之后、系统提示与用户批次提交之前运行；**不能改 messages**" | `packages/core/agent/src/runtime-types.ts:330-345` |
| 派发点 | `const proposedConfig = await this.dispatch.waterfall('agent/request', {turn,step,signal}, () => Promise.resolve(seedConfig))` | `packages/core/agent-loop/src/agent.ts:593` |
| 谁"注入 agent" | `agentEvents(ctx, agent)` 的 `fused()`：`{ ...payload, agent }`（payload 里自带的 `agent` 字段无法覆盖注入值） | `packages/core/agent/src/dispatch.ts:94-160` |
| 作用域过滤 | `scopeTarget()`：未打 scope tag 的监听器（根 ctx）**全局准入**；打了 tag 的只准本 key 或其祖先 | `packages/core/scope/src/index.ts:159-176`（注释原文 "listeners tagged with an ancestor receive events dispatched to a descendant key"） |
| waterfall 顺序 | `cbs = dispatch(...)`（**注册顺序**，`prepend` 才 unshift），`next()` 从 `cbs.shift()` 开始、`inner`（seed）最后；**先注册 = 最外层 = 返回值最后覆盖、最终生效** | `vendor/cordis/src/events.ts:225-250,288-300`；`vendor/cordis/src/events.ts:159-176` |
| 结果去向 | `prepareCall(proposedConfig)` → `config = preparedCall.config` → `buildRequest(config,…)` → `canonicalHeader({config, adapterDefaults, tools})` → `session.append('request/header', {header,…})` | `packages/core/agent-loop/src/agent.ts:601-650` |
| 头规范化不过滤 config | `canonicalHeader` 只规范化 `tools` 与 `adapterDefaults`，**`config` 原样透传** | `packages/core/session/src/request-header.ts:21-32` |
| 下一轮 seed | 后续请求以 `requestProposal(persistedHeader)` 为 seed（即上一轮**落盘的** config），所以显式 effort 会**跨 step 粘住** | `packages/core/agent-loop/src/agent.ts:580-590` |

### 1.2 实测（[实测]，命令与输出原文）

命令（真 `@deepseek-ai/cordis` + 真 `dsh-scope` + 真 `dsh-agent` 的 `agentEvents`，非手搓模拟）：

```powershell
$code = @'
import { Context } from 'file:///D:/Program/deepseek-harness/vendor/cordis/lib/index.js';
const { createScope } = await import('file:///D:/Program/deepseek-harness/packages/core/scope/lib/index.js');
const { agentEvents } = await import('file:///D:/Program/deepseek-harness/packages/core/agent/lib/index.js');
const root = new Context();
const agent = { id: 'agent-A', session: { id: 'session-A' } };
const scope = createScope(root, agent);           // 等价于 Agent 构造里的 createScope(loopCtx, this)
const log = [];
// OMB 形态：根 ctx、注册早（boot 期）
root.on('agent/request', async (payload, next) => { log.push(['root:enter', payload.agent === agent, payload.agent?.session?.id]); const r = await next(); log.push(['root:unwind:got', JSON.stringify(r)]); return { ...r, reasoningEffort: 'low' }; });
// model-selection 形态：agent 作用域、注册晚（会话创建期）
scope.ctx.on('agent/request', async (_p, next) => { const r = await next(); log.push(['scoped:unwind', JSON.stringify(r)]); return { ...r, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }; });
const out = await agentEvents(root, agent).waterfall('agent/request', { turn: 1, step: 0, signal: new AbortController().signal }, () => Promise.resolve({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }));
log.push(['final', JSON.stringify(out)]);
console.log(JSON.stringify(log, null, 1));
'@; $code | node --input-type=module -
```

输出（原文）：

```json
[
 ["root:enter", true, "session-A"],
 ["scoped:unwind", "{\"provider\":\"deepseek-official\",\"model\":\"deepseek-flash\",\"reasoningEffort\":\"max\"}"],
 ["root:unwind:got", "{\"provider\":\"deepseek-official\",\"model\":\"deepseek-flash\",\"reasoningEffort\":\"max\"}"],
 ["final", "{\"provider\":\"deepseek-official\",\"model\":\"deepseek-flash\",\"reasoningEffort\":\"low\"}"]
]
```

三条读法：

1. **(a) 根 ctx 监听器收到事件**：`root:enter` 被调用，且 `payload.agent === agent`、`payload.agent.session.id === 'session-A'` ⇒ 可按 `session.id` 分派。
2. **(c) 顺序语义**：根（注册早）在最外层，`await next()` 先拿到 agent 作用域的 `'max'`，再在 unwind 时覆盖成 `'low'` ⇒ **根的返回值赢**。`final` 里就是 `'low'`。
3. **(b) 落到请求头**：由 §1.1 的链路保证（waterfall 返回 → `prepareCall(...).config` → `canonicalHeader` 原样保留 `config` → `session.append('request/header', {header})`）。**注意**：`prepareCall` 会**校验** effort（见 1.3），所以"写进头"的前提是"该模型支持"。

### 1.3 `reasoningEffort` 的合法值与校验 [源码]

- 值是 branded `ReasoningEffortId`（`packages/llm/llm/src/brand.ts:67-75`）。
- DeepSeek 适配器声明 **`off` / `low` / `high` / `max`** 四档（`packages/llm/llm-deepseek/src/model-info.ts:6-32`）；**没有 `medium`**。配置文件层也是这个闭集：`reasoningEffort: z.union(['off','low','high','max'])`（`packages/llm/llm-deepseek/src/config.ts:24,94`）。
- 校验发生在 `resolveCallWithInfo`（`packages/llm/llm/src/index.ts:900-940`）：
  - 模型 `reasoning === undefined`（不支持）而请求里带了 effort ⇒ 抛 `LlmError('… does not support reasoning effort "x"', 'UNSUPPORTED_REASONING_EFFORT')`；
  - 模型支持但请求的 id 不在 `reasoning.efforts[].id` 里 ⇒ 同样抛；
  - 通过则 `resolvedConfig.reasoningEffort = 请求值`；未请求时用 `defaultEffort`。
- `agent-loop` 的 `prepareRequest` 只吞 `NO_ADAPTER`，**其它错误上抛**（`packages/core/agent-loop/src/agent.ts:601-615`）⇒ **盲设 effort = 让该步请求硬失败**。本 profile 里 `opencode-go` 的 pi-ai 路由（`llm-pi-ai`）不保证声明 reasoning ⇒ 这是真实风险，不是理论风险。
- 能力探测的正规入口：`ctx.llm.resolveModelInfo(provider, model)`（公开，`packages/llm/llm/src/index.ts:756-762`）→ 看 `info.reasoning?.efforts` 里有没有目标 id；有就设，没有就**原样返回**（不设字段）。注意它 async，且可能触到 adapter ⇒ OMB 侧要做 (provider,model) 级缓存。
- `adapterDefaults.reasoningEffort: true` 只在"调用方没显式请求、由适配器默认补上"时置位（`packages/llm/llm/src/index.ts:976-984`）。OMB 一旦显式设置，这个标记消失 ⇒ 恢复会话时的 `persistedReasoningEffort` 还原逻辑会把它当**显式**值（`agent-loop/src/agent.ts:580-590`）⇒ **跨 step 粘住，必须显式清除才能回落默认**。

### 1.4 (e) `sessionController.selectModel`：不是干净的路 [源码]

- `selectModel(request)`：`llm.resolveCallConfig(...)` 校验 → `agents.selectForNextRequest(agent, selected)` → **`void this.ctx.agentDefaultModel.saveSelection(selected)`**（docstring 原文："Validate and install one Session-local model selection; **save the default in the background**"）。
  `packages/api/session-controller/src/commands.ts:157-179`。
- **所以它会把"用户默认模型选择"改掉**，并异步落盘（失败只 warn）。这不是 OMB 想要的"只改当前请求"。
- `selectForNextRequest` 做两件事：`agent.session.append('model/selection', selection)` + `selectionFor(agent).current = selection`（`packages/api/session-controller/src/agent.ts:339-342`）。
- **只 append `model/selection` 事件不会改动已装好的活选择**：活选择由 `selectionFor()` 首次调用时 `installModelSelection(agent.ctx, selection)` 装一次并缓存在 `selections` map 里（`agent.ts:289-333`；`agent.ts:586` 只在特定路径重建），此后只有 `selectForNextRequest` 会改 `current`。结论：**"往会话里追加 `model/selection`" ≠ 改变下一轮请求**；而能改的那两个入口一个是宿主内部方法（插件不可达的远程面），一个带"改用户默认"的副作用。
- 相比之下 `agent/request` waterfall 是**唯一"只影响请求、不落用户默认"**的可达面。

### 1.5 推荐代码形状（OMB `dsh/` 层，不 import 任何 `@deepseek-ai/*`）

```ts
// 新增 dsh/request-effort.ts；在 kernel apply() 里同步接线（H-2），disposer 不抛（H-1）
import type { HostContextLike } from './host.js'

const EFFORT_BY_DEPTH = { quick: 'low', standard: undefined, deep: 'max' } as const

export function wireRequestEffort(
  ctx: HostContextLike,
  opts: {
    depthOf(sessionId: string): 'quick' | 'standard' | 'deep' | undefined
    // (provider, model) → 支持哪些 effort；未探测到/不支持就返回 undefined
    supportedEfforts(provider: string, model: string): Promise<ReadonlySet<string> | undefined>
  },
): () => void {
  if (typeof ctx.on !== 'function') return () => {}
  const off = ctx.on('agent/request', async (payload: unknown, next: () => Promise<unknown>) => {
    const cfg = (await next()) as { provider?: string; model?: string; reasoningEffort?: string }
    try {
      const agent = (payload as { agent?: { session?: { id?: string } } }).agent
      const id = agent?.session?.id
      const depth = id === undefined ? undefined : opts.depthOf(id)
      const wanted = depth === undefined ? undefined : EFFORT_BY_DEPTH[depth]
      if (wanted === undefined || cfg.provider === undefined || cfg.model === undefined) return cfg
      const supported = await opts.supportedEfforts(cfg.provider, cfg.model)
      if (supported === undefined || !supported.has(wanted)) return cfg   // 不支持就绝不设
      return { ...cfg, reasoningEffort: wanted }
    } catch {
      return cfg // 绝不因为认知层让请求失败（H-1 同源）
    }
  }) as (() => void) | undefined
  return () => { try { off?.() } catch { /* H-1 */ } }
}
```

`depthOf` 的实现面已经存在：OMB 内核有会话→cwd 的 `ActiveSessionTable`（`kernel/activeSession.ts`），`omb_focus` 深度也已经在会话维度存着；只是把"当前 depth"读给这个监听器。

### 1.6 排序/时序风险清单（Q1）

| # | 风险 | 机制 | 判据 / 缓解 |
|---|---|---|---|
| E1 | **注册顺序反了就不生效** | waterfall 先注册=最外层=最后覆盖。OMB 在 boot 期注册 ⇒ 早于会话创建 ⇒ 赢。但若将来改成"首个 `omb_focus` 时才懒注册"，它就变成内层，会被 model-selection 覆盖 | 判死现象：`request/header.config.reasoningEffort` 仍等于默认值。缓解：必须在 kernel `apply()` 里注册（同步），不得懒注册 |
| E2 | **不支持的模型直接炸请求** | `prepareCall` 抛 `UNSUPPORTED_REASONING_EFFORT`，`prepareRequest` 只吞 `NO_ADAPTER` | 判据：非 deepseek 路由（`opencode-go/*`）下把 depth 设 deep，看该步是否报错。缓解：先 `resolveModelInfo` 探能力，探不到就不设 |
| E3 | **显式值跨 step 粘住** | 下一轮 seed = 上一轮落盘 header 的 config | 判据：depth 从 deep 改 quick 后，header 是否立刻变。缓解：每次请求都按当前 depth 显式写；回落默认要写 `reasoningEffort: undefined` |
| E4 | **缓存失效** | 文档明说 reasoningEffort 是 request-header 状态、影响 cache reuse（`packages/llm/llm/src/call-config.ts:1-6`）；`headerEquals` 把 effort 计入变化（`request-header.ts:41-58`） | 判据：每次 effort 变化后下一次请求的 cacheReadTokens 是否掉。缓解：只在**用户动作**（`omb_focus`）或回合边界改档，不要每 step 变 |
| E5 | **子 agent 也被命中** | 根监听器收到**所有** agent 的事件（含 host 的 subagent/team/ralph）。`payload.agent.session.header.parentSession` 可用来判谱系 | 缓解：只对 OMB 登记过的会话设档；或按 `parentSession` 继承父会话档位 |
| E6 | **监听器里的 await 拖慢请求** | 每个请求都会走一遍 | 缓解：深度查表 O(1)；`supportedEfforts` 必须缓存 |
| E7 | **与 `adapterDefaults` 语义打架** | 显式设值会清掉 `adapterDefaults.reasoningEffort:true` 标记 | 接受并写进文档；不要期望"清除后自动回落到适配器默认"以外的行为 |

**结论**：feasible at root ctx（不需要 `agent.ctx`），但必须满足 E1/E2/E6 三条工程约束。

---

## Q2 —— 会话搜索子行能否被 profile patch 覆盖

### 2.1 结论：**能**（[实测]）

bundle 层 `insert` 出来的组 `optional-session-search`（`packages/experimental/session-search/cordis.patch.yml:1-14`）：

```yaml
- id: optional-session-search
  name: cordis:group
  group: true
  isolate:
    sessionQuery: true
  config:
    - id: optional-session-query-sqlite
      name: '@deepseek-ai/dsh-session-query-sqlite'
      config: { path: ':memory:', openAt: first-search }
    - id: optional-tool-session-query
      name: '@deepseek-ai/dsh-tool-session-query'
```

两个子行都**可以**被 `- id:` patch 覆盖（profile 层与 overlay 层都试过）。

### 2.2 探针（[实测]，临时 DSH_HOME，不碰真实 profile）

准备：

```powershell
$t='D:\Program\omb-wt\_probe\r4h'
New-Item -ItemType Directory -Force -Path "$t\profiles\web" | Out-Null
Copy-Item 'C:\Users\SuSeventeen\.dsh\profiles\web\package.json'        "$t\profiles\web\package.json"
Copy-Item 'C:\Users\SuSeventeen\.dsh\profiles\web\cordis.patch.yml'    "$t\profiles\web\cordis.patch.yml"
Set-Content "$t\profiles\web\cordis.yml" "[]"
$env:DSH_HOME=$t
node D:\Program\deepseek-harness\apps\cli\lib\bin.js --profile web --dump-config 2> "$t\err-base.txt" | Set-Content "$t\dump-base.yml"
```

基线（`exit=0 bytes=50762`）里组是完整的：

```yaml
- id: optional-session-search
  name: cordis:group
  group: true
  isolate:
    sessionQuery: true
  config:
    - id: optional-session-query-sqlite
      name: '@deepseek-ai/dsh-session-query-sqlite'
      config:
        path: ':memory:'
        openAt: first-search
    - id: optional-tool-session-query
      name: '@deepseek-ai/dsh-tool-session-query'
```

（**注**：stderr 里有 5 条 `skipping profile bundle …` 与 `patch: entry "path-guard"/"omb-*" not found`，都来自临时 home 里解析不到的**第三方/OMB bundle**，与本题无关；基线 50,762 字节。）

**A. 覆盖工具行**（overlay）：

```powershell
@'
- id: optional-tool-session-query
  config:
    searchTimeoutMs: 600000
    maxSearchResults: 10
'@ | Set-Content "$t\overlay-tool.yml"
node ...\bin.js --profile web --patch "$t\overlay-tool.yml" --dump-config 2> "$t\err-tool.txt" | Set-Content "$t\dump-tool.yml"
# exit=0 bytes=50898；err-tool.txt 里没有任何 "optional" 相关告警
```

diff（原文节选）：

```
# == @deepseek-ai/dsh-experimental-session-search, patched by D:\Program\omb-wt\_probe\r4h\overlay-tool.yml =>
        searchTimeoutMs: 600000
        maxSearchResults: 10
      config:
# == @deepseek-ai/dsh-experimental-session-search  <=
```

**B. 覆盖 SQLite 行**（overlay）：

```powershell
@'
- id: optional-session-query-sqlite
  config:
    path: 'D:\Program\omb-wt\_probe\r4h\index.sqlite'
    openAt: first-search
'@ | Set-Content "$t\overlay-sqlite.yml"
node ...\bin.js --profile web --patch "$t\overlay-sqlite.yml" --dump-config 2> "$t\err-sqlite.txt" | Set-Content "$t\dump-sqlite.yml"
# exit=0 bytes=50853；无告警
```

diff 原文：

```
# == @deepseek-ai/dsh-experimental-session-search, patched by ...\overlay-sqlite.yml =>
        path: D:\Program\omb-wt\_probe\r4h\index.sqlite
# == @deepseek-ai/dsh-experimental-session-search  <=
        path: ':memory:'   <=
```

**C. 直接写进 profile 层**（最贴近真实用法：把两段追加到临时 home 的 `profiles/web/cordis.patch.yml`，不是真实的那个）：

```powershell
Add-Content "$t\profiles\web\cordis.patch.yml" @'

- id: optional-tool-session-query
  config:
    searchTimeoutMs: 600000
    maxSearchResults: 20
- id: optional-session-query-sqlite
  config:
    path: 'D:\Program\omb-wt\_probe\r4h\session-search.sqlite'
    openAt: first-search
'@
node ...\bin.js --profile web --dump-config 2> "$t\err-profile.txt" | Set-Content "$t\dump-profile.yml"
# exit=0 bytes=50951；无 optional 告警
```

diff 原文：

```
# == @deepseek-ai/dsh-experimental-session-search, patched by ...\profiles\web\cordis.patch.yml =>
        path: D:\Program\omb-wt\_probe\r4h\session-search.sqlite
        searchTimeoutMs: 600000
        maxSearchResults: 20
      config:
# == @deepseek-ai/dsh-experimental-session-search  <=
        path: ':memory:'
```

### 2.3 给 Lead 的精确 YAML（真实 profile 用；本线程未写真实 profile）

```yaml
# C:\Users\SuSeventeen\.dsh\profiles\web\cordis.patch.yml 末尾追加
- id: optional-session-query-sqlite
  config:
    path: C:\Users\SuSeventeen\.dsh\cache\session-search.sqlite
    openAt: first-search          # 保持懒开；不要 startup（会把 ~30-60s 冷建搬到启动）
- id: optional-tool-session-query
  config:
    searchTimeoutMs: 600000       # 上限 2147483647
    maxSearchResults: 20          # 压输出体积，减少被 pruner 腰斩
```

注意事项：

1. `path` 是**派生索引**（dedicated derived index）：文件不存在会被 owner-only 创建；目录会 `recursive` 创建（`packages/session-query/session-query-sqlite/src/schema.ts:31-53`）。schema 版本是 8，**宿主升级换代时版本不符会在原地重建**（`schema.ts:8,58-67`）。
2. 组仍然是 `isolate: {sessionQuery:true}` ⇒ **OMB 依旧不能从插件里调它**，改配置只是让**模型面工具**可用。
3. 该组不会因为 profile patch 变成根服务；`--dump-config` 的层来源注释会显示 `patched by …\cordis.patch.yml`，可当作"生效"的核对点。
4. 若 `path` 指向不可写位置，首次搜索会 `SESSION_QUERY_INDEX_FAILED`（`index.ts:369-381`）。

### 2.4 冷建索引到底要多久：实测分项（[实测] + [推导]）

同一份语料（391 个 `session.v4.jsonl.zstd`，283.7MB 压缩），把 `observeSession` 真实做的每一步单独量出来：

| 步骤（与源码一一对应） | 实测 | 对应源码 |
|---|---|---|
| zstd 解帧 + 解压 | **5.6s** | `session-persistence-jsonl` reader |
| `JSON.parse`（258,166 条记录） | **2.3–3.1s** | `handle.read` / `observeSession` 入参 |
| `structuredClone(events)` | **4.1s** | `session-query-sqlite/src/index.ts:873-887` |
| `JSON.stringify(detachedEvents)`（指纹用） | **2.8s** | 同上 |
| `sha256` | **1.3s** | 同上 |
| `buildSessionEventSearchDocuments` | **0.22s**（产出 **145,508 篇**文档，均 1,431 字符） | `packages/session-query/session-query/src/documents.ts` |
| FTS5 写入（按 22k docs/s 实测速率外推 145.5k 篇） | **≈ 4–7s** | `index.ts:582-614`（另含 `sanitizeFtsText` + `Array.from(text).length` 的逐篇码点计数） |
| `persistence.list()` ×2 + 每会话 `handle.read` 的校验开销 | 未单列 | `index.ts:495-562` |

**合计 ≈ 22–28s 纯 CPU（单线程、本机空载）**，再叠加 GC 与上述未单列开销 ⇒ **正好压在 30s 线上**。这解释了为什么 Lead 的 4 次调用**全部**超时、而只要机器稍忙就必超；也说明 `searchTimeoutMs: 600000` 足够跑完一次（预计 30–60s），之后同一进程内 `_reconcile` 只重读变化会话，应在亚秒级；重启后持久 `path` 仍可复用（除非 schema 换代重置或语料大面积改写）。

**未做**：没有在真实 profile 上真跑一次冷建（规则要求"不得对真实 profile 运行"）。要端到端确认，Lead 可在**新会话**里（改完配置、重启宿主后）发**一次** `session_search` 并计时；判据是它返回结果而不是 `timed out`，且 `contextWindow` 接近上限时 pruner 不把结果腰斩。

---

## 3. 两个判词的风险补充

| 风险 | 影响 | 缓解 |
|---|---|---|
| Q1-E2：对不支持 effort 的模型设值 | 该步请求硬失败（`UNSUPPORTED_REASONING_EFFORT`） | `ctx.llm.resolveModelInfo` 先探能力，探不到就不设；包 try/catch |
| Q1-E1：懒注册导致被覆盖 | 静默无效（effort 仍是默认） | 必须在 kernel `apply()` 同步注册；判据看 `request/header.config.reasoningEffort` |
| Q1-E4：每 step 改档 | 请求缓存反复失效，成本可能高于省下的 token | 只在 `omb_focus` 或回合边界改档 |
| Q2-1：持久索引体积 | 145.5k 文档 / 200MB 文本 ⇒ 索引文件预计数百 MB 量级（**未实测**，[推导]） | 放在 `~/.dsh/cache/` 下，可随时删（派生数据） |
| Q2-2：schema 换代重建 | 宿主升级后首次搜索又变慢 | 接受；或用 `openAt: never` 回退到"只精确读" |
| Q2-3：改的是隔离实例 | OMB 插件仍不可程序化调用 | 若 OMB 需要程序化搜索，只能走自建索引（见主报告 §4.3 模式 B2） |

---

## 4. 本次探针产物

- 临时 home：`D:\Program\omb-wt\_probe\r4h\`（`profiles/web/{package.json,cordis.patch.yml,cordis.yml}`、`dump-{base,tool,sqlite,profile}.yml`、`err-*.txt`、`overlay-*.yml`）——**探针完成后已删除**；命令与输出原文见 §2.2，可原样重跑。
- 未产生任何对真实 profile / OMB 仓库的写入；未安装任何包；真实 `cordis.patch.yml` 的 mtime 停在本次会话之前（2026-10-18 13:46:05）。
