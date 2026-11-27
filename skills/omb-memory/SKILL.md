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

- `memory`：必填 `category`（fact/clue/event）；至少一个非空可选属性。`fact` 是已证实稳定内容，`clue` 是未证实内容，`event` 是日志类非知识内容。
- `state`：必填 `title`、`status`、`time`；不要给 `category`。
- `chain`：必填 `title`、`group`；`group` 是记忆、状态机或状态历史 id 列表，不要求它们之间已有链接。

`scope` 缺省是 project（由会话 cwd 推项目键）；没有 cwd 时项目作用域无法确定，写入会被拒绝（`invalid-input`）；跨项目偏好显式给 `scope=global`。

## 属性

- `attrs` 是自由属性；普通 JSON 是静态值，`{"$dynamic": {...}}` 是动态值。
- 动态值可用：`ref`（读另一个实体的属性）、`template`、`file`（项目根内）、`regex`、`code`（QuickJS 沙箱，100ms/16MB/无网络）、`task`（DSH 子代理/团队/后台任务）。`url` 只在宿主配置 `urlAllowlist` 且目标不在私网/环回时可用，默认关闭。
- 必填字段用顶层参数，不要塞进 `attrs`；属性名不要以 `$` 开头，也不能与必填名重名。
- 不要用固定 schema 套所有记忆；优先复用工具返回的「相似属性名」，避免同义属性名泛滥。

## 写入前

工具会返回相似属性、相似记忆和已归档冲突。按这个顺序处理：

1. 同内容已存在 → 不重复写，改用 `omb_link` 建关系；
2. 近似但数字/条件不同 → 写成新条目，用 `omb_link` 链接 `related_to` 或 `possible_conflict`；
3. 旧结论被推翻 → 新条目 + `omb_link` 到旧条目 `supersedes`。`supersedes` 只是普通关系标记：旧条目照常参与检索，不会被自动归档或降权；要让它退出普通检索，再 `omb_admin action=archive targetId=...`；
4. 已归档条目要恢复 → 先 `omb_admin action=unarchive targetId=...`；`omb_update` 不能直接改已归档条目。

## 关系与组

- `omb_link`：`from`/`to`/`relation` 必填，`relation` 1–64 字符；`directed` 缺省 true，`strength` 缺省 0.5；已归档端点默认拒绝，`allowArchived=true` 才放行。取消链接用 `unlinkId`。
- 建组用 `omb_remember kind=chain`，不要把组当链接。

## 不要做

- 不要把用户原话改写成有损摘要；需要摘要时放可选属性 `summary`，保留原文。
- 不要为了「看起来完整」编造属性值；没有值就不写。
- 不要在没有 id 的情况下声称更新了某条记忆。
