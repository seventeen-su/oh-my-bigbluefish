---
name: omb-state
description: "任务开始/推进/阻塞/完成，或需要状态机历史与链接时用；状态、归档与历史规则。"
user-invocable: false
---

# 状态机

## 什么时候用

- 一个目标/任务开始、推进、等待、阻塞、完成或丢弃；
- 用户问“现在做到哪了”“还有什么没闭环”；
- 需要查某个状态机的历史版本；
- 需要把任务和记忆/报告/其它状态机连起来。

## 状态值

`completed` 已完成、`in_progress` 进行中、`waiting` 等待中、`blocked` 阻塞中、`not_started` 未开启、`discarded` 已丢弃。

- 状态机必填 `title`、`status`、`time`、`scope`；不要给 `category`。
- `completed`/`discarded` 会自动归档；其它状态需要手动归档。
- 归档独立于状态：归档后不出现在普通检索，但已有链接/组仍能解析。
- 可选动态属性 `statusRule`（regex/code 等）会在后台 `omb.refresh` 求值；返回值必须是六态之一，
  与当前状态不同时自动走 `omb_update`（生成历史，完成/丢弃仍自动归档）。

## 更新

- `omb_update` 必须带 `expectedRevision`（从 `omb_recall` 或 `omb_history` 拿）；
- 每次更新自动写历史版本；历史**不可回滚**，只能查看或引用；
- 状态变化要同时更新可选属性里的证据/备注，别只改状态。

## 历史

`omb_history(id)` 返回版本快照。历史版本可被链接、引用、入组；普通检索只显示当前版本并标 `historyCount`。

## 链接

- 依赖：`depends_on`
- 来源：`derived_from`
- 取代：`supersedes`（旧条目保留，不物理删除）
- 冲突：`possible_conflict`（双向；手工取消后不再自动标记）
- 合并：`merged_into` / `merged_from`
