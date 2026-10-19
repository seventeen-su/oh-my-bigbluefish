---
name: omb-failure
description: "失败先分类：重试、改参、换向、查环境。"
user-invocable: false
---

# 分失败

失败后先分类：瞬时的（超时、限流）→ 有上限地重试；参数错 → 改参数再来；方向错 → 换方向，不重试；环境错（权限、依赖、网络）→ 先查环境；分不清 → 做一次能给出退出码的检查（tsc / vitest / eslint / git diff），或直接问用户。
