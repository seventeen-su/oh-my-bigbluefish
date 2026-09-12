// layer 0（substrate/）：诊断输出的**闸门**（默认静默）。
//
// 为什么需要它：布局初始化/修复、启动自动回退这类过程会在正常运行时打印诊断行（含 git 的
// "Preparing worktree…" 与只读 ACL 导致的同步失败告警）。这些信息对排障有价值，但**不该默认
// 污染宿主终端**——尤其"只读 worktree 同步失败"在当前设计下是**预期**结果（worktree 只读、
// 回退只切 ref），每次回退都打一遍会让人误以为出了故障。
//
// 层 DAG 约束：substrate(0) 不能 import runtime(2) 的降级面，故这里自带一个层中立的开关，
// 由上层（plugin 装配期）用 `setDiagnostics` 打开；也可用环境变量 `OMB_DEBUG=1` 打开
//（便于不经过插件直接跑脚本时排障）。
//
// 纪律：**日志可以被静音，状态不能被静音**。诊断行只是"顺手打印"；真正的状态始终经
// `recordDegradation` / 状态面暴露，与这个开关无关。

let debugEnabled = process.env.OMB_DEBUG === '1' || process.env.OMB_DEBUG === 'true';

/** 当前是否开启诊断输出（状态面/测试可读） */
export function diagnosticsEnabled(): boolean {
  return debugEnabled;
}

/** 打开/关闭诊断输出（插件装配期按配置调用；缺省关闭） */
export function setDiagnostics(enabled: boolean): void {
  debugEnabled = enabled;
}

/** 诊断行（默认不输出；开启后经 console.info） */
export function diag(message: string): void {
  if (debugEnabled) {
    console.info(message);
  }
}

/** 诊断告警（默认不输出；开启后经 console.warn） */
export function diagWarn(message: string): void {
  if (debugEnabled) {
    console.warn(message);
  }
}
