# AGENTS.md — 给在此仓库工作的 agent

本仓库是 **OMB v4.1**：DSH（DeepSeek Harness）的通用认知增强插件。先读这一段，再读代码。

## 1. 分层（不要跨层）

| 层 | 目录 | 允许做什么 |
| --- | --- | --- |
| 内核/ABI | `kernel/` | 服务总线、事件总线、健康面、catalog、display；**零业务逻辑** |
| 宿主适配 | `dsh/` | **唯一**接触宿主 Context/服务/文件系统/子进程的层；v4.1 新增 `dsh/project-root.ts`（项目身份 = git root，供记忆库/画像/`omb_project` 共用） |
| 模块 | `modules/` | 纯逻辑 + `kernel` 端口；**禁止 import `@deepseek-ai/*`**（ESLint 强制） |
| 包壳 | `packages/` | 薄 re-export + `default` 宿主插件入口 |
| 预设/补丁 | `cordis.patch.yml` | 行、组、`!!js` 表达式；改它先读 `cordis-composition-reference` |
| 证据/计划 | `docs/` | 设计、兼容性、研究报告；**事实优先于叙述** |

单一真源：模块清单与工具面在 `kernel/abi/catalog.ts`；插件页名称/说明在 `kernel/display.ts`；
行与顺序在 `cordis.patch.yml`；构建代数在 `build-generation.json` / `lib-gen/g<N>`。

## 2. 不变量（违反会静默失效，测试不一定红）

1. **模块不接触宿主**：需要宿主事实时，由 `dsh/` 通过内核服务（`SERVICES.*`）或事件提供；形状用结构化最小接口。
2. **接线必须有消费者**：声明/服务/事件都要能指出生产调用点；"已注册"不等于"已生效"。
3. **状态面只说事实**：读数带来源与时间；没有测量就写"未测量/为什么"，不要显示成 0 或绿。
4. **记忆逐字保真**：不做有损摘要；冲突只呈现；supersede 非破坏；隐私是用户命令，模型不能放宽。
5. **热路径零 LLM**：写入准入、检索、捕获、状态都不得调用模型；只有用户显式要求的独立复核可例外。
6. **token/注意力预算**：工具 schema 与常驻提示都是每请求成本；新能力优先做参数/按需文件，不新增常驻散文。
7. **缓存前缀**：`systemPrompt.context()` 在 DSH 是**尾部 user/message 快照**，不是系统提示段；真正要逐字节稳定的是跨会话项目前缀（`AGENTS.md`/skills 目录/常驻句）。
8. **构建产物最后生成一次**：`lib-gen` 换代必须全量一致；混代会产生两个内核实例。
9. **项目身份 = git root**：记忆库、项目画像、`omb_project` 一律先 `SERVICES.projectRoot` 再按根取库；
   子目录会话**不得**另起项目库；非 git 目录退化为 cwd。解析在 `dsh/`（模块不跑子进程），失败绝不抛。
10. **守卫 = 资源级内容哈希 + 显式未知**：写守卫按**该文件内容哈希**（读取时固化 `sha256` 前 16，≤2MB）
    判定，不用全局 epoch；`edit` 与 `write` 同一判定表；缺印记/超限/读失败一律放行但必须计
    `blindWrites`/`unverifiable`，**不得静默**；fail-open 是设计（守卫不是权限边界），但异常必须留声。
    逃生门：同路径同回合第 3 次放行并计 `gaveUps`（防死锁，参见 Claude Code issue #33856）。

## 3. 命令

```powershell
npx tsc --noEmit          # 类型门禁
npx eslint .              # 分层/风格门禁
npx vitest run            # 全量测试
node scripts/build.mjs    # 构建一次，代数 +1；不要在门禁里反复跑
node scripts/check-resolution.mjs
```

部署：宿主加载的是 `C:\Users\SuSeventeen\.dsh\profiles\web\node_modules\@omb\*` 的真实副本，
不是本仓库。同步流程：`git pull` → `node scripts/build.mjs` → 同步 `lib-gen`/组件目录 → relink → 重启 `dsh web` → `omb_status` 核对代数。

## 4. 高频坑（都踩过）

- 宿主会话事件边界是 `step/start`/`step/end`，不是 `turn/start`；`tool/call.arguments` 是未解析 JSON 字符串。
- 投影 `stateOf()` 返回 **host state**：`contextPressure` 没有 `projectedTokens`（自己算 `pressureTokens+surfaceTokens−sampledSurfaceTokens`）；`tokenUsage` 是 `{totals,last}`；`contextBreakdown` 是嵌套 `breakdown.*`。
- `systemPrompt.context()` 是尾部快照；`systemPrompt.section` 才是系统提示段。
- 预设内组可能 `isolate`（compaction/toolResultPruner/sessionQuery）：根 realm 拿不到；`ctx.get` 与 `ctx.<name>` 语义不同（后者需 inject）。
- 会话搜索 `fts5(unicode61)` 中文子串不可用；OMB 的 bigram FTS 是中文唯一通道。
- 构建代数（g<N>）是为绕 ESM 缓存；状态面必须同时核对加载/磁盘/部署清单。
- Windows 路径/长路径/符号链接：复制用 `fs.cpSync(..., {dereference:false, verbatimSymlinks:true})`。

## 5. 当前方向（2026-10）

- **v4.1（当前，4.1.0 / g90）** = **时空坐标**：项目身份 = git root；写守卫 = 资源级内容哈希（edit+write）；
  自主捕获 = `tool/call` → `tool/result` 生命周期；`omb_project` = L0–L5 分层时空快照（≤2,400 字符，隐私先于读取）。
  契约：`docs/v4.1-spacetime.md`；审查回应：`docs/research/2026-10-18-v4-review-response.md`。
- v4.0 = 记忆自主化 + 项目画像 + 事件图 + 推理技能化 + 上下文归零。
- 依据：`docs/v4-decision.md`（含 §9 v4.1 决策）与 `docs/research/2026-10-18-*.md`（14 份，含产品/结构审计与状态机设计）。
- 不要恢复：`omb_verify`、逐回合控制散文、未接线服务、写入时 LLM 抽取、GraphRAG、替换宿主压缩。
- v4.1 明确不做（不要在文档里假装已做）：符号级 repo-map、三方合并、shell 写追踪、子代理写集、`AGENTS.md` 指纹。
