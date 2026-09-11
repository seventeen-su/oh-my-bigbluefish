---
name: omb-runtime
description: OMB v2 认知层使用说明——命令/工具语义、记忆与画像请求格式、认知过程推进、制品恢复、验证债务（按需加载）
---

# OMB v2 认知层使用说明

本技能按需加载：需要历史记忆或用户画像、登记偏好、处理不确定验证、切换版本线、或投影提示推进时加载。只讲怎么用，不涉及内部架构。

## 命令

- `/mode <initial|stable|latest>`：切换版本线，切换后后续请求生效。
- `/bench`：运行冻结基准（无 DSH 会话 → 回放，有 → 真实执行）。
- `/evolve now`：演化判定 + 维护量子；`/evolve share`：发布机制级共享对象；`/evolve absorb <id>`：吸收共享对象。

## 工具请求格式

- `kern_memory {op: "retrieve", query, scope: "Session"|"Project"|"Global", kind?, limit?}`：记忆检索（`op` 缺省即 retrieve；`scope` 缺省 project、`limit` 缺省 5）。
  **`scope` 取值区分大小写**（首字母大写）：传 `project` 会被 schema 拒绝并返回 `Invalid option: expected one of "Session"|"Project"|"Global"`。
- `kern_profile {profile, replace?}`：登记/更新用户画像（Global 跨项目可检索）。
- `kern_status`：运行时状态摘要；`kern_bench`：运行基准；`kern_evolve`：触发演化全链；`kern_switch`：切换版本线。

## 认知过程

投影含「认知过程」时按过程推进；`next_best_action` 指向过程时执行之。

## 制品恢复

上下文候选含「制品」条目时，可按其 `path` 用读取类工具恢复。

## 验证债务

`UNKNOWN` 是合法终态，不要强迫猜测；不确定的验证进债务队列，维护期统一处理。

## 边界

正常任务优先直接完成，不主动加载 OMB 内部机制；未验证候选不视为可信能力；认知层仅观察与注入，不接管 Agent Loop。
