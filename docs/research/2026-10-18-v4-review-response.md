# OMB v4 审查逐条回应（2026-10-18）

- 审查来源：ChatGPT 对 OMB v4 的审查报告，经 Lead 转达（条目见下；本文件按"审查称…"逐条引用其要点）。
- 被审对象：**v4.0.0**（`18ec311` / g88）。
- 复核基线：`HEAD = 7842ab1`（`feat: v4.1 时空坐标与并发编辑守卫`，4.1.0 / g89）。旧行为一律用 `git show 18ec311:<file>` 复核，不复述记忆。
- 复核方式：只读 git 命令 + 源码行号（未改代码、未跑 build、未提交）。每条给出判定、证据、v4.1 动作、残留。
- 判定口径：**不成立**＝与仓库事实不符；**成立**＝事实存在，v4.1 用代码修复或显式降级；**部分接受**＝保留原设计的取舍，但补齐可观测性；**明确不做**＝写清理由与版本边界。

## 0. 结论摘要

12 条审查点：**不成立 2 条；审查正确但无需为本次改版行动 1 条；确认成立并已在 v4.1 修复 6 条；确认成立但采用"显式计数而非硬拦" 2 条；确认成立、明确留待 v4.2 1 条。**

| # | 审查点 | 判定 | v4.1 落点 |
| --- | --- | --- | --- |
| 1 | 根目录没有 `AGENTS.md` | **不成立** | — |
| 2 | `modules/context/index.ts` 仍可访问 | **不成立**（v4.0 已删；锁文件残留 1 处） | 已知未闭合 #1 |
| 3 | `typescript` 仍是 6.0.3，却提 TS7.1 | **成立**（但不需要为本次改版升级） | 不改依赖；canary 独立 |
| 4 | 守卫用陈旧 epoch，不是文件内容 | **成立** | 资源级内容哈希（§4 判定表） |
| 5 | `writeIntent` 不清空 | **成立** | `turn/start` 边界清空 |
| 6 | `write` 只警告、不拦截 | **成立** | edit+write 统一判定 |
| 7 | 缺读取戳时不拦 | **成立**（保留放行，改为显式计数） | `blindWrites++` / `unverifiable++` |
| 8 | 守卫 fail-open | **部分接受**（设计取舍，但必须可见） | 日志 + 计数 + 状态面 |
| 9 | 自主捕获把"尝试"记成"完成" | **成立** | pending → result 生命周期 |
| 10 | 项目身份按 cwd 分裂 | **成立** | `SERVICES.projectRoot`（git root） |
| 11 | `omb_project` 无显式隐私门控 | **成立** | `privacyAllowsRead` + sealed 全拒 |
| 12 | 项目画像不是符号级 repo-map | **成立，明确不做**（v4.2） | `docs/v4.1-spacetime.md` §8 |

> 两条"不成立"都必须靠命令证明，不靠叙述：审查者可能看的是旧提交、旧分支、缓存页面或转述。§4 给出可复跑命令与预期输出。

---

## 1. 逐条回应

### 1.1 审查称"根目录没有 `AGENTS.md`" —— **不成立**

证据（2026-10-18 复核）：

```text
$ git cat-file -e HEAD:AGENTS.md          # exit 0
$ git log --oneline -1 -- AGENTS.md       # ce2816e feat: v4 记忆自主化与推理技能化
$ git log --oneline --diff-filter=A -- AGENTS.md   # 首次加入 = ce2816e
```

- `AGENTS.md` 自 `ce2816e`（v4 首个提交）起就在库中，且 `git cat-file -e` 对 HEAD 返回 0；工作树中也存在（v4.1 已按 §5 方向再更新）。
- 审查者若看的是 GitHub 网页/raw URL，请注意：raw 只对**某个 ref** 有效；`ce2816e` 之前的 ref 没有该文件，但这不等于当前仓库没有。

**残留**：无。

### 1.2 审查称"`modules/context/index.ts` 仍可访问（raw 源码）" —— **不成立**

证据：

```text
$ git ls-tree -r --name-only HEAD | Select-String '^modules/context'   # 无输出
$ Test-Path modules/context     # False
$ Test-Path packages/context    # False
```

- `omb-context` 组件在 v4.0 已整体删除（模块/包/行/测试，见 `docs/v4-completion.md:39`，−1,769 行）；压力/cache/压缩读数折叠进 `omb_status` 顶层。
- **唯一残留**：`pnpm-lock.yaml` 仍列已删除的 `@omb/context`（1 处；见 `docs/v4-completion.md:57` 的已知未闭合 #1）。它不影响构建与加载，下次 `pnpm install` 会刷新。

**判定**：源码可访问的说法不成立；锁文件残留成立且已记录。

### 1.3 审查称"`package.json` 的 typescript 仍是 `~6.0.3`，却在报告里提 TS 7.1.0-dev" —— **成立**

证据：

```text
$ (Get-Content package.json -Raw | ConvertFrom-Json).devDependencies.typescript   # ~6.0.3
$ (Get-Content package.json -Raw | ConvertFrom-Json).version                      # 4.1.0
```

- `docs/v4-completion.md:13` 写的是"TS 7.1.0-dev canary：`tsc --noEmit` 0 类型错误（**不进门禁**）"——它是独立的一次 canary 验证，不是依赖升级，也不是 v4.1 的前置条件。
- v4.1 不升级 TypeScript：升级是独立决策，需单独评估 `~6.0.3 → 7.x` 对全仓 32 个改动文件之外的影响；本版不夹带。

**判定**：审查事实正确；结论"因此报告不可信/需立刻升级"不成立（canary 已标注不进门禁）。

### 1.4 审查称"写守卫用陈旧 epoch 判断，而不是文件内容" —— **成立，已修**

旧实现（`git show 18ec311:dsh/state-machine.ts`）：

- L38：`无读 stamp 的 edit **不 deny**`；
- L350：`守卫判定：edit 在"读后 epoch 变了"时 deny（≤2 次/路径/回合）；write 只 warn`。

问题：全局 epoch 是**工作区级**摘要——任何一个无关文件变化都会让所有 edit 进入"epoch 变了"分支；反过来，如果脏集摘要恰好没覆盖（未跟踪文件、被 `.gitignore` 忽略），读后被改的文件也可能漏判。前者是误伤（模型被拒绝但文件没被改过），后者是漏判（真正并发改动的文件被放行）。

v4.1 修复（`HEAD:dsh/state-machine.ts:1216-1280`）：

- 读取时对文件内容算 **sha256 前 16**（`ReadStamp.hash`，单文件上限 2MB，`HASH_MAX_BYTES`）；
- 守卫按**该文件当前内容哈希**与印记哈希比较：相同 allow；不同 deny（≤120 字符事实句，含 `旧hash→新hash` 前 8 位）；
- 不再把全局 epoch 当作 deny 依据（epoch 仍用于状态行与外部改动计数）。

**残留**：`hash === null`（目录/超 2MB/读失败）与当前内容读不到时一律 `unverifiable` 放行——见 1.7/1.8。

### 1.5 审查称"`writeIntent` 不清空" —— **成立，已修**

旧实现证据：`git show 18ec311:dsh/state-machine.ts | Select-String 'writeIntent'` 只有 `add`（L984）与上界淘汰（L985-988），**没有 `clear()`**。后果：一旦某路径被写过，本会话后续所有回合都把它当"自己写的"，外部改动被永久归因为己方（漏报外部改动）。

v4.1 修复：`HEAD:dsh/state-machine.ts:1053-1054` 在 `turn/start` 边界 `record.writeIntent.clear()`；`noteWriteResult` 只在本回合成功后重新加入（`HEAD:1287-1317`）。

**残留**：shell 写文件的路径不进 `writeIntent`（见 §3 明确不做）。

### 1.6 审查称"`write` 只警告、不拦截" —— **成立，已修**

旧实现证据：`git show 18ec311:dsh/state-machine.ts:350` 明写 `write 只 warn`；`EditGuardDecision.kind` 含 `'warn'`。

v4.1 修复：`DEFAULT_WRITE_TOOLS = ['edit','write','edit_file','write_file','multi_edit']`（`HEAD:98`），`guardEdit` 对 edit 与 write **同一判定表**。收尾清理：`SessionSituation.sideEffects` 中原有的 `writeWarnings` 字段**已被删除**（它只被初始化、从未递增，状态面会恒显 0）；`SessionStateSnapshot.guard.writeWarnings` 仅作为旧版快照字段保留，没有 UI 消费。见 §3.1 C1。

**残留**：写工具名是**配置白名单**（`config.writeTools`）；若宿主新增写工具而未加入白名单，守卫不会覆盖——状态面可看到 `blindWrites`/`unverifiable`，但需要人看。

### 1.7 审查称"缺读取戳时不拦" —— **成立；v4.1 保留放行，但改为显式计数**

这是一个必须在文档里说清楚的取舍：

- 事实：`HEAD:dsh/state-machine.ts:1242-1247`：无印记且目标文件存在 → `allow` + `blindWrites++`；无印记且文件不存在 → `allow`（新建）。
- **为什么不改成硬拦**：
  1. 读取可能发生在 shell 里（`pwsh`/`bash` 的 `Get-Content`/`cat`），OMB 只订阅文件工具事件，无法证明"没读过"；硬拦会误伤（Claude Code 的官方行为也是"用 Bash 查看文件同样满足读前置条件"，[tools-reference](https://code.claude.com/docs/en/tools-reference)）。
  2. 硬拦 + 模型不重读会死锁（Claude Code issue #33856："Edit/Write 永久卡在 unexpectedly modified"，[issue #33856](https://github.com/anthropics/claude-code/issues/33856)）。
- **v4.1 的修法是"让未知可见"**：`blindWrites`（盲写既有文件）、`unverifiable`（印记无哈希/当前读不到）、`deny/gaveUps`（拦截与放弃）都进 `situation()` 与 `omb_status`；L2 行会写"读取印记 N（已变化 x / 无法核验 y）"。

**残留**：这是观测性修复，不是防护性修复；是否升级为"缺戳也拦"需要先量出 shell 读占比（P1 探针，见 `docs/research/2026-10-18-state-machine.md` §14）。

### 1.8 审查称"守卫 fail-open" —— **部分接受（保留取舍，补齐可见性）**

- 现状：`HEAD:1276-1279` 守卫内部异常（端口抛错、路径非法、状态文件损坏）→ `allow` + `warn('guardEdit', …)`；`HEAD:1259` 当前内容读不到 → `allow`（计 `unverifiable` 只在 `value === null` 时）。
- **为什么保留 fail-open**：守卫是 `tools/pre-execute` 上的旁路，不是权限边界；让它 fail-closed 会把"状态文件损坏"升级为"所有写操作被拒"，成为单点故障（与 v4.1 契约 §6.3"绝不抛"一致）。
- v4.1 补的是**可观测性**：所有异常走 `warn`（进状态面日志）；`unverifiable` 计数；`situation().sideEffects.unverifiable` 可查；状态面不把它伪装成"0"。

**残留**：fail-open 期间不拦是设计选择，不是缺陷修复；若未来要 fail-closed，应做成显式配置并单独压测。

### 1.9 审查称"自主捕获把'尝试'记成'完成'" —— **成立，已修**

旧实现证据（`git show 18ec311:modules/memory/capture.ts`）：

- L565 注释：`成功判定在调用侧（tool/call）已经足够；这里保留订阅是为了将来按 ok 收窄。`
- L566-568：`tool/result` 只在 `ok === false` 时给 activityKey 打标记，**不在 call 侧改写已写下的文本**。
- 因此 `tool/call` 时就写"编辑文件：x"，失败/未返回也留下"完成"语义。

v4.1 修复（`HEAD:modules/memory/capture.ts:22-31,602-705`）：

- `tool/call` 只按 `callId` 建 **pending**（每会话 20 / 全局 512），不写库；
- `tool/result`：`ok===true` → 写旧文本；`ok===false` → 写 `未生效：…`（`FAILED_PREFIX`，同一事实轴、明确未生效）；`ok===undefined` → 不写并计 `unknown-result`；
- 无匹配 pending → 计 `no-pending`；`turn/end` 未解决 → 丢弃并计 `unconfirmed`；
- 无 `callId` 时退回旧行为并计 `unconfirmed-call`（**明确记录的降级**）；
- 统计新增 `failed/unconfirmed/unknownResult/noPending/unconfirmedCall/pending`，进 `omb_status` 记忆段。

**残留**：无 callId 的降级路径仍在；这是宿主事件形状的边界，不是静默行为。

### 1.10 审查称"项目身份按 cwd 分裂" —— **成立，已修**

旧实现证据（`git show 18ec311:modules/memory/store.ts`）：

- L2031：`join(projectIdentity(cwd), DATA_DIR_NAME, …)`；
- L2672、L2847：`const key = projectIdentity(cwd)`。

后果：同一 git 仓从子目录启动的会话会得到不同的项目库（`<subdir>/.omb/memory/session.db`），项目记忆被切成两半。

v4.1 修复：

- 新服务 `SERVICES.projectRoot = 'omb:project-root'`（`HEAD:kernel/abi/catalog.ts:356`），实现 `HEAD:dsh/project-root.ts:112-175`：`git -C <cwd> rev-parse --show-toplevel`，同步、2.5s 超时、缓存 TTL 60s/128 项、失败/非 git 退化为规范化 cwd、绝不抛；
- `stores` 增加 `projectRootOf`（`HEAD:modules/memory/store.ts:2469-2471`），`ensureProject`/`forProject`/`peek` 一律先解析根再 `projectIdentity(root)`（`HEAD:2699-2700,2875`）；
- `projectScope` 与记忆 `project` 字段 = 项目根；项目画像同样在根构建，`cwdRel` 保留"我在哪"（`HEAD:dsh/project-profile.ts:99-105,547-613`）。

**残留**：非 git 目录仍退化为 cwd（契约如此）；一个 cwd 在解析 TTL 内被移动/换成另一个仓库时，根会短暂陈旧（60s 可接受，状态面 epoch 会变）。

### 1.11 审查称"`omb_project` 无显式隐私门控" —— **成立，已修**

旧实现证据：`git show 18ec311:modules/memory/project.ts | Select-String 'privacy|sealed'` **无任何匹配**——工具只按库边界取数，画像不经过库，所以 sealed 会话仍可读到画像。

v4.1 修复：

- `createProjectTool` 新增 `privacyAllowsRead`（`HEAD:modules/memory/project.ts:189`）；
- 工具 handler 在**任何读取之前**判定（`HEAD:546-559`）：`allowRead=false` → 返回"当前会话不可读（隐私模式 sealed，或隐私判定失败）——没有读取项目画像与项目记忆"；
- 接线在记忆模块（`HEAD:modules/memory/index.ts:1196-1204`）：隐私服务缺席 = 可读；`decide` 抛错 = **不可读（fail-closed）**；
- 无会话归属：只允许画像、不读记忆（`project.ts:18`）。

**残留**：门控只在 `omb_project`；其它读路径仍以库边界（`gateSet`）为准——若未来新增"画像直读"路径，必须走同一 `privacyAllowsRead`。

### 1.12 审查称"项目画像不是符号级 repo-map" —— **成立；明确不做，留 v4.2**

- 现状：画像提供 `identity/structure/history/gates`（顶层目录、源码目录文件数/行数/测试数、入口、docs 标题、构建命令、最近提交、脏文件数），**没有函数/类/调用图**（`HEAD:dsh/project-profile.ts:99-105,278-391`）。
- v4.1 契约 §8 已写明：符号级 repo-map 需要语言服务、收益未验证，留给 v4.2；本版不假装。
- 若要评估：先做只读探针（tree-sitter/tsc LSP 成本 vs 收益），按 `docs/v4.1-spacetime.md` §7 的门禁方式立项，不在文档里先承诺。

**残留**：`structure.sources` 的文件/行/测试计数是**静态扫描**（有界 2,000 文件、跳过 node_modules/.git/lib-gen 等），不是符号粒度。

---

## 2. v4.1 修复的验收对应（写文档时同时钉住）

| 修复 | 契约节 | 代码 | 测试 |
| --- | --- | --- | --- |
| 资源级内容哈希守卫（edit+write） | §4 | `dsh/state-machine.ts:1216-1280` | `tests/dsh/state-machine.test.ts`（321 行变更） |
| post-execute 自写刷新 + writeIntent 回合清空 | §4 | `state-machine.ts:1053-1054,1287-1317`；`wireEditGuard` `1568-1620` | 同上 |
| 捕获生命周期 pending→result | §3.5 | `modules/memory/capture.ts:22-31,602-705` | `tests/modules/memory/capture.test.ts`（168 行变更） |
| 项目根身份（git root） | §3.1/§3.6 | `dsh/project-root.ts:112-175`；`store.ts:2469-2471,2699-2700` | `tests/dsh/project-root.test.ts`（170 行变更）；`tests/modules/memory/project-root.test.ts`（208 行变更） |
| 隐私先于读取 | §5 | `modules/memory/project.ts:546-559`；`index.ts:1196-1204` | `tests/modules/memory/project-tool.test.ts`（347 行变更） |
| 六层快照 L0–L5 + situation | §2/§3.3 | `modules/memory/project.ts:270-623`；`state-machine.ts:1481-1540` | 同上 + `tests/dsh/project-profile.test.ts`（115 行变更） |

> 表中测试数字取自 commit `7842ab1` 的 `git show --stat`（32 files, +3,356/−459），是**变更行数（新增+删除）**，不是用例通过数；**通过数不写死**，门禁数字由 Lead 在 `docs/v4-completion.md` 填。

---

## 3. 仍未解决 / 明确不做（不假装）

| 项 | 状态 | 理由 / 去向 |
| --- | --- | --- |
| shell 写文件追踪（`pwsh` 的 `>`/`sed -i`/`git apply`） | **不做** | 无法可靠归因；守卫对 shell 永不拦；`writeIntent` 只归因文件工具（`docs/v4.1-spacetime.md` §8） |
| 子代理写集并入父会话归因 | **不做** | 需要父/子会话关联与事件权限；当前只在状态面体现"外部/未知" |
| `AGENTS.md` 指纹进 epoch | **不做** | 契约 §8 明列；会引入"读自身触发变化"的循环 |
| 符号级 repo-map | **v4.2** | 语言服务依赖 + 收益未验证 |
| 三方合并 / 生成补丁 | **不做** | 守卫只做"读后被改 → 拒绝并让模型重读"；合并交给用户/git |
| TypeScript 7.x 升级 | **不在本版** | 独立决策；canary 已单独跑（`docs/v4-completion.md:13`） |
| `pnpm-lock.yaml` 的 `@omb/context` 残留 | **已知未闭合** | 下次 `pnpm install` 刷新（`docs/v4-completion.md:57`） |
| 缺读取戳时硬拦 | **观察项** | 先量 shell 读占比（P1），再决定是否升级为"缺戳也拦" |

---

### 3.1 本轮发现的文档-代码矛盾（已处理）

| # | 矛盾 | 处理 |
| --- | --- | --- |
| C1 | `situation().sideEffects.writeWarnings` 在代码中**只初始化、只读取，没有递增点**（旧 `dsh/state-machine.ts` 初始化处；`dsh/status-tool.ts` 回退行显示"write 警告 N 次"）→ 状态面恒显 0，违反"未测量 ≠ 0" | **已修（v4.1 收尾）**：从 `SessionSituation.sideEffects` 删除该字段；状态面回退行不再显示恒 0 的 write 警告。`SessionStateSnapshot.guard.writeWarnings` 仅作旧快照兼容保留，无 UI 消费 |
| C2 | `README.md` 旧边界写"**不阻断工具调用**"，而 v4.1 守卫会对单次 edit/write 返回 deny | 已改 README：写成"明示例外 + 一次拒绝 + 第 3 次放行 + 不回滚/不重试" |
| C3 | `README.md` 旧"项目库（随 cwd）"，与 v4.1 的 git root 身份不符 | 已改为"`<git root>/.omb/memory/session.db`；非 git 退化为 cwd" |
| C4 | `docs/v4-completion.md` 旧"已知未闭合 #2：守卫按 R10 偏差"与 v4.1 代码不符 | 已划掉并注明 v4.1 修复；保留历史记录 |
| C5 | `staleWrites` 的语义：实际在**写调用**时按"距上次读 >20 步"计数（`HEAD:1134-1136`），不是"写后变陈旧" | 文档按实际语义写；若后续要改名为 `staleReadWrites`，需同步 `situation` 字段 |
| C6 | 宿主 `workspace-changes` 已在跑（520 事件/27 会话，R10 实测），但 v4.1 状态机未消费它 | 不阻塞本版；作为 v4.2 的现成数据源候选（减少自算 git） |


## 4. 复核命令（只读，可复跑）

```powershell
# 1) AGENTS.md 在库
git cat-file -e HEAD:AGENTS.md; "exit=$LASTEXITCODE"          # 期望 exit=0
git log --oneline --diff-filter=A -- AGENTS.md                 # 期望首条 ce2816e

# 2) modules/context 已删
git ls-tree -r --name-only HEAD | Select-String '^modules/context'   # 期望无输出
Test-Path modules/context; Test-Path packages/context               # 期望 False False
Select-String -Path pnpm-lock.yaml -Pattern '@omb/context'         # 期望 1 处（已知未闭合）

# 3) TypeScript 版本
(Get-Content package.json -Raw | ConvertFrom-Json).devDependencies.typescript  # 期望 ~6.0.3
(Get-Content package.json -Raw | ConvertFrom-Json).version                     # 期望 4.1.0

# 4) 旧行为（审查成立项）
git show 18ec311:dsh/state-machine.ts | Select-String '无读 stamp 的 edit|write 只 warn|epoch 变了'
git show 18ec311:modules/memory/store.ts | Select-String 'projectIdentity\(cwd\)'
git show 18ec311:modules/memory/project.ts | Select-String 'privacy|sealed'    # 期望无输出
git show 18ec311:modules/memory/capture.ts | Select-String '成功判定在调用侧'

# 5) 新行为（修复项）
Select-String -Path dsh/state-machine.ts -Pattern 'guardEdit =|noteWriteResult =|writeIntent.clear|hash === stamp.hash'
Select-String -Path dsh/project-root.ts -Pattern 'rev-parse|MAX_ENTRIES|绝不抛'
Select-String -Path modules/memory/capture.ts -Pattern '未生效：|unconfirmed|unknown-result'
Select-String -Path modules/memory/project.ts -Pattern '隐私模式 sealed|MAX_SNAPSHOT_CHARS|L0|L5'
```

**预期输出摘要**：`cat-file exit=0`；AGENTS.md 首条 `ce2816e`；`modules/context` 无匹配；lockfile 1 处；TS `~6.0.3`；旧守卫含"不 deny / write 只 warn / epoch 变了"；旧 store 含 `projectIdentity(cwd)`；旧 project 无 privacy；旧 capture 含"成功判定在调用侧"；新代码含哈希比较、`writeIntent.clear()`、`未生效：`、`隐私模式 sealed`、L0/L5 渲染。

---

## 5. 与上一轮 ChatGPT 批评的关系（避免混为一谈）

上一轮批评的三条（"存储/关联 ≠ 连续项目认知"、"自动集成 ≠ 自动学习"、"推理/上下文缺统一收益目标"）针对的是**机制层**，不是 v4.0 的代码事实：

- v4.1 只补"**坐标与对账**"（身份/读集/增量/时间 + 六层快照），**不宣称学习**——自动捕获只写可观测事实，目标关闭只认可核验证据；
- 统一收益目标仍在 `docs/v4-architecture.md` §5 的 VOC 不等式，v4.1 新增机制（守卫、六层快照）都进了判定表，并有 kill/降级判据（`docs/v4.1-spacetime.md` §4/§7）。

**一句话**：审查里 2 条事实错误、1 条事实正确但结论过度、6 条已修、2 条按取舍显式降级、1 条明确留给 v4.2——没有"已完成但代码没有"的能力被写进文档。
