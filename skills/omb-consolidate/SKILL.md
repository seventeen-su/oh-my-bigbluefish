---
name: omb-consolidate
description: "需要查看/回滚后台巩固、合并冲突、清理低显著度记忆、核对证据来源时用；巩固调度、幂等与证据规则。"
user-invocable: false
---

# 后台巩固与审计

## 调度模型：事件驱动为主、周期兜底为辅、失败恢复

后台**不再每 10 分钟全表扫一轮**。写入/链接/属性改名/artifact 落库会通过 outbox reaction 立即触发
**定向**任务；durable timer 只负责漏事件兜底与时间驱动维护，进程崩溃后由 timer 行/outbox 租约恢复。

| 任务 | 主路径（事件） | 周期兜底 | 备注 |
|---|---|---|---|
| 抽取 | artifact 落库 → `omb.extract`（artifactId） | 15 分钟 | 只处理该 artifact |
| 去重 | `EntityCreated/EntityPatched` memory → `omb.dedupe`（entityId） | 2 小时 | 只对目标实体做近邻 |
| 冲突 | 同上 → `omb.conflict`（entityId） | 2 小时 | 只与目标实体近邻比较 |
| 线索晋升 | 线索写入或 `EvidenceAdded` → `omb.clue-promote`（entityId） | 2 小时 | 先查该线索自己的引用腐化 |
| 引用腐化 | `EntityPatched` / `AttributeRenamed` → `omb.reference-rot`（entityId） | 2 小时 | 只看指向该实体的引用 |
| 链接建议 | `LinkCreated/LinkUnlinked` → `omb.link-suggest` | 2 小时 | — |
| 遗忘 | 无（语义是低频巡检） | 6 小时 | 偏好/置顶豁免 |
| 属性名归并 | 无（语义是低频巡检） | 6 小时 | 只对 ASCII 名可比 |
| 动态刷新 | 写入事件提前一次 | 10 分钟 | 动态值本身按 `stale_after_ms` 过期 |
| 向量补齐 | 写入事件 → `omb.embed` | 30 分钟 | 补齐缺失/失败向量 |

`omb_status` 的 `consolidationModes=` 会报每个任务当前分类（event/time/fallback）。
reaction 一律用 `singletonKey` 合并同一实体的事件风暴；任务执行完由调度驱动的执行方 rearm 下一期。

## 写入幂等（两层）

1. **工具调用 commandId**：`omb_remember`/`omb_update` 用宿主 `callId` 合成稳定键
   （`tool:<tool>:<session>:call:<callId>`）；同一调用重试命中 `audit_log.command_id` 唯一索引，
   返回首次结果，不重复写实体/审计。
2. **内容幂等**：内容指纹 = kind + scope + category + 全部非易失属性（含 title/body/时间属性）。
   完全相同内容复用原实体，**新证据并入原实体证据集**并写 `EvidenceAdded` 事件；
   不同项目/不同时间/不同内容（相似但不等）的事实照常并存。
   `evidence`/`artifactId`/`promoted*`/`userConfirmed` 等溯源属性不参与指纹。

## 线索晋升必须有真实证据

证据不再来自 `attributes.evidence` 字符串（模型自证无效），而是 `omb.evidence` 账本：

- 字段：`source_type`(user/tool/file/session/verification)、`source_id`、`observed_at`、
  `content_hash`、`confidence`、`verification_status`(unverified/verified/refuted)、`subject_key`；
- **来源独立性**：按 `subject_key` 去重。两个 session 引用同一文件 → 同一 subjectKey → 只算一份；
  同一会话重复写同一内容也只算一份；
- 晋升条件（满足其一）：系统 verification=verified；高置信 user 证据；≥2 个独立来源。
  有 refuted 结论则一律不晋升；单来源永远不晋升。

### 证据由谁写入

| 生产者 | 场景 | source_type |
|---|---|---|
| 工具写路径 | `omb_remember` 调用（无文件引用） | session（同会话重复只算一份） |
| 工具写路径 | 内容引用文件路径 | file（按文件主题去重） |
| 用户确认 | `origin=user` 或 `userConfirmed=true` | user |
| artifact 抽取 | goal/task/子代理报告落库后 | session（无文件）/ file（有文件） |
| 系统 | 线索晋升时写结论 | verification（verified/refuted） |

`omb_update` 目前只带稳定 commandId，不产生新证据；证据只由 remember、artifact 抽取、系统校验写入。

## 后台会做什么（语义不变的部分）

- 抽取：`goal/*` → 状态机；`team/*`/`task/*` → 状态机；`subagent/*`/`job/*` → 线索记忆。
- 去重：只看最近 30 条非置顶、当前有效（`lifecycle=active`）的记忆；全文/向量近邻（向量原始分 ≥0.9），
  文本相似度 ≥0.82 或属性重叠，数字不一致不合并；保留较早 canonical，归档较新 duplicate，
  写双向 `merged_into`/`merged_from`。
- 冲突：只比较最近 30 条当前有效的事实类记忆；属性值矛盾时写双向 `possible_conflict`；
  `omb_link unlinkId=...` 取消后写抑制表。
- 链接建议：共同召回 ≥2 次写 `co_recalled`（强度 = min(1, 次数/5)）；连通组 ≥3 条建链。
- 遗忘：显著度低于 0.35 归档（新近度 + utilityConfidence 证据 + 置信度 + 分类）；`pinned` 与偏好标签豁免。
- 属性名归并：只对 ASCII 属性名可比（pg_trgm 对中文恒 0），中文同义名不会自动归并；
  改名后逐实体重建视图/引用。
- 向量补齐与动态刷新（含 `statusRule` 自动推进状态）。
- 生命周期：被取代（`superseded`）、被证伪（`retracted`）、已归档的条目都不参与去重/冲突/线索晋升/
  成组/遗忘/向量补齐——它们是历史证据，后台不能把它们改写成当前事实。

## 什么时候看审计

- 用户问「为什么这条被合并/归档/改了/晋升了」；
- 需要撤销某次后台写；
- 需要确认宿主面/队列是否健康。

## 工具

- `omb_admin action=audit [limit]`：列最近审计（`action=evidence` 是内容幂等的证据并入）；
- `omb_admin action=rollback auditId=N`：按 inverse 回滚一次；回滚本身也记审计；
- `omb_admin action=replay outboxId=N|topic=...`：重放 dead outbox 行；
- `omb_status`：数据库、实体计数、归档数、嵌入、队列、事件运行时与巩固调度分类的实测读数。

## 回滚边界

- 支持：写入撤销（归档该实体）、归档/取消归档、建链/取消链接、patch 恢复旧属性与 revision、取代回滚（`unsupersede`：恢复旧条目当前有效并归档取代链接）、证伪回滚（`unretract`）；
- 一次只回滚一条审计；复杂合并按审计记录逐条处理；
- 证据并入（`EvidenceAdded`）没有 inverse，不随 rollback 删除；回滚不是「时间旅行」，
  后续写入不会被自动撤销；不要声称回滚了整个会话。
- 取代（`unsupersede`）/证伪（`unretract`）都是可回滚审计；`supersedes` 关系不能单独
  `unlinkId` 取消（会破坏生命周期一致性）。
