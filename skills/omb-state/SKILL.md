---
name: omb-state
description: "任务开始/推进/阻塞/完成，或需要状态机历史与链接时用；状态、归档与历史规则。"
user-invocable: false
---

# 状态机

## 什么时候用

- 一个目标/任务开始、推进、等待、阻塞、完成或丢弃；
- 用户问「现在做到哪了」「还有什么没闭环」；
- 需要查某个状态机的历史版本；
- 需要把任务和记忆/报告/其它状态机连起来。

## 状态值

`completed` 已完成、`in_progress` 进行中、`waiting` 等待中、`blocked` 阻塞中、`not_started` 未开启、`discarded` 已丢弃。

- 状态机必填 `title`、`status`、`time`，不要给 `category`。
- `completed`/`discarded` 写入或更新时自动归档；其它状态需要 `omb_admin action=archive` 手动归档。
- 归档独立于状态：归档后不出现在普通检索，已有链接/组仍能解析；但不能再 `omb_update`，先 `omb_admin action=unarchive targetId=...`。
- 可选动态属性 `statusRule`（regex/code 等）由后台 `omb.refresh` 求值：结果必须是上面六态之一，与当前状态不同时按新状态走一次更新（生成历史；完成/丢弃仍自动归档）。后台是固定周期（约 10 分钟）批处理，不是实时；单实体单轮最多刷新 4 个动态属性，`statusRule` 可能排到下一轮。

## 更新

- `omb_update` 的 `expectedRevision` 是必填：用最近一次 `omb_remember`/`omb_update` 返回的 `revision`。
- 版本对不上会返回 `conflict`，错误信息里带上「实际 N」，下一次用这个 N 重试即可；不要凭空猜版本号。
- 只有状态机更新会自动写历史快照；记忆和思维链没有历史版本。
- 历史**不可回滚**，只能查看或引用；状态变化要同时更新证据/备注属性，别只改状态。

## 历史

`omb_history(id)` 返回快照列表（`rev=` 是当时的版本号，不是当前版本），历史版本可被 `omb_link` 链接、被动态 `ref` 引用、加入思维链组；普通检索只显示当前版本并标 `历史：N 个版本`。

## 链接

- 用 `omb_link` 建关系：`depends_on` 依赖、`derived_from` 来源、`supersedes` 取代（普通关系标记，不自动归档/降权）、`possible_conflict` 冲突（双向；手工 `unlinkId` 取消后不再自动标记）、`merged_into`/`merged_from` 合并。
- `directed` 缺省 true；已有链接端点归档后仍能解析，但不能再建新链接（除非 `allowArchived=true`）。
