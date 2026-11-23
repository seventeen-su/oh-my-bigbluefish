---
name: omb-memory
description: "需要长期记住、去重、归档或组织事实/线索/事件时用；单库属性化记忆的写入规则。"
user-invocable: false
---

# 写记忆

## 什么时候写

- 用户给出长期偏好、已确认事实、项目决定、稳定约束；
- 任务中出现了一条尚未证实、但以后可能有用的线索；
- 需要记录一条日志类事件（不必证实，但以后可能要追溯）；
- 需要把已有记忆组织成思维链（组）。

一次性任务细节、代码片段复述、助手自己的推理不要写成长期记忆。

## 三种单位

- `memory`：必填 `category`（fact/clue/event）+ `scope`；至少一个非空可选属性。`fact` 是已证实稳定内容，`clue` 是未证实内容，`event` 是日志类非知识内容。
- `state`：必填 `title`、`status`、`time`、`scope`；不要给 `category`。`status` 只能是 completed/in_progress/waiting/blocked/not_started/discarded。
- `chain`：必填 `title`、`group`、`scope`；`group` 是记忆/状态机 id 列表，不要求它们之间已有链接。

## 属性

- `attrs` 是自由属性；普通 JSON 是静态值，`{"$dynamic": {...}}` 是动态值。
- 动态值可用：`ref`（读另一个实体的属性）、`template`、`file`（项目根内）、`regex`、`code`（QuickJS 沙箱，100ms/16MB/无网络）、`task`（DSH 子代理/团队/后台任务）。
- 不要用固定 schema 套所有记忆；优先复用工具返回的“相似属性名”，避免同义属性名泛滥。
- 属性名不要以 `$` 开头；必填字段用顶层参数，不要塞进 `attrs`。

## 写入前

工具会返回相似属性、相似记忆和已归档冲突。按这个顺序处理：

1. 同内容已存在 → 不重复写，改用 `omb_link` 建关系；
2. 近似但数字/条件不同 → 写成新条目，链接 `related_to` 或 `possible_conflict`；
3. 旧结论被推翻 → 新条目 + 链接旧条目 `supersedes`，不要原地覆盖；
4. 已归档冲突需要恢复 → 显式给 id 并用 `omb_update`/归档工具处理，不要另写一条。

## 不要做

- 不要把用户原话改写成有损摘要；需要摘要时放可选属性 `summary`，保留原文。
- 不要为了“看起来完整”编造属性值；没有值就不写。
- 不要在没有 id 的情况下声称更新了某条记忆。
