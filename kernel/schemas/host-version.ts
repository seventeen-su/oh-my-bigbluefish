// layer 2（kernel/schemas/）：R6 唯一宿主版本来源（dsh_version 防漂移）。
//
// 背景（评估第十六节）：多个 Event/Experience provenance 硬编码 dsh_version（'0.8.0'/'0.1.0'/
// '0.1.1-rc.1' 混用）而正式环境已 0.1.1-rc.1——污染 Provenance/Environment Fingerprint/
// Capability Decay/Evolution comparison，属实现错误。修复原则：运行时从唯一宿主版本来源读取 →
// 所有 Event/Memory/Experience/Snapshot 使用同一值。
//
// 唯一来源默认值 = 当前宿主 DSH 版本（本机 0.1.0-rc.7，research-dsh 实测；README 前置
// >=0.1.0-rc.7；GitHub 最新 0.1.1-rc.1）。升级宿主后经装配注入面（PluginConfig.hostVersion →
// createCognitiveRuntime({ hostVersion }) → setHostVersion）更新，无需改码。
//
// 层 DAG（CONVENTIONS §4）：kernel/schemas 为 IR 契约层——supervisor(1) → kernel/schemas/ 放行
//（eslint no-cross-layer-import 例外，tests/m0/dag-lint.test.ts 钉住）；runtime(2)/kernel(2) 同层。
// 本模块放 kernel/schemas 而非 kernel/ 根，正是为了 supervisor(1) 各 provenance 工厂可直接引用。

/** 当前宿主 DSH 版本（唯一来源默认值；升级宿主后经装配注入面更新，不改码） */
export const DSH_HOST_VERSION = '0.1.0-rc.7';

/** 装配/测试注入的覆写（undefined = 使用默认 DSH_HOST_VERSION） */
let injectedHostVersion: string | undefined;

/**
 * 设置宿主版本覆写（装配注入面：PluginConfig.hostVersion → createCognitiveRuntime 装配期传入；
 * 测试注入同面）。非法值 fail-loud（FingerprintSchema dsh_version 亦要求非空字符串）。
 */
export function setHostVersion(version: string): void {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`hostVersion: 非法版本 "${String(version)}"（须为非空字符串）`);
  }
  injectedHostVersion = version;
}

/** 读取唯一宿主版本来源（注入优先，缺省 DSH_HOST_VERSION）——运行时所有指纹/provenance 经此取同一值 */
export function hostVersion(): string {
  return injectedHostVersion ?? DSH_HOST_VERSION;
}
