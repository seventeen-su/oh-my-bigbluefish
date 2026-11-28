---
name: omb-consolidate
description: "需要查看/回滚后台巩固、合并冲突、清理低显著度记忆时用；审计与后台任务规则。"
user-invocable: false
---

# 后台巩固与审计

## 后台会做什么

后台约每 10 分钟一轮，把抽取/去重/冲突/链接建议/遗忘/刷新等任务投进队列：

- 从 DSH artifact 抽取：`goal/*` 抽成状态机（标题「目标：…」）；`team/*` 或 `task/*` 抽成状态机（标题「任务：…」）；`subagent/*` 与 `job/*` 只写成一条标题为「子代理报告」的线索记忆，不抽状态机。
- 去重：只看最近 30 条非置顶记忆；全文/向量近邻（向量原始分 ≥0.9）取候选，文本相似度 ≥0.82 或属性重叠命中，且数字不一致不合并。只归档较新的重复项（duplicate），较早的 canonical 保持活跃，并写双向 `merged_into`/`merged_from` 链接。
- 冲突：只比较最近 30 条事实类记忆，属性值矛盾时写双向 `possible_conflict`；手工 `omb_link unlinkId=...` 取消后写入抑制表，不再自动标记。
- 线索转事实：先跑引用腐化检测；`evidence` 里至少两个不同 `session:<id>`，或 `userConfirmed=true`/`assertedBy=user`，或 `verified=true` 才转 `fact`。这些属性没有系统写入者，必须由写入方显式提供。
- 链接建议：共同召回 ≥2 次写 `co_recalled` 链接（强度 = min(1, 次数/5)）；连通组 ≥3 条生成思维链（`autoGroupKey` 去重）。
- 遗忘：按新近度/置信度/分类与机会级使用证据算显著度，低于阈值 0.35 的归档；`pinned` 与偏好标签豁免。`access_count` 和单纯召回（Exposure）**不提高**显著度、不降低遗忘概率；只有同一 `(entity, session, task)` 机会里的 Reference/Utilization/Validation 受控加分（Validation 最强），用户否定/证伪会负向扣分。重复召回只增加同一机会的 `exposures`，不会重复累计成功次数。
- 属性名归并：只对 ASCII 属性名可比（pg_trgm 对中文恒 0），中文同义名不会自动归并；改名后逐实体重建视图。
- 向量补齐与动态刷新（含 `statusRule` 自动推进状态）。

## 什么时候看审计

- 用户问「为什么这条被合并/归档/改了」；
- 需要撤销某次后台写；
- 需要确认宿主面/队列是否健康。

## 工具

- `omb_admin action=audit [limit]`：列最近审计；
- `omb_admin action=rollback auditId=N`：按 inverse 回滚一次；回滚本身也记审计；
- `omb_status`：数据库、实体计数、归档数、嵌入、队列与宿主面的实测读数。

## 回滚边界

- 支持：写入撤销（归档该实体）、归档/取消归档、建链/取消链接、patch 恢复旧属性与 revision；
- 一次只回滚一条审计；复杂合并按审计记录逐条处理；
- 回滚不是「时间旅行」：后续写入不会被自动撤销；不要声称回滚了整个会话。
