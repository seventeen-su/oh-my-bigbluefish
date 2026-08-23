// OMB v2 三线部署核心（developer tooling；供 CLI scripts/deploy-lines.ts 与测试 tests/m8/deploy-lines.test.ts）。
// 纯逻辑核心：planLinePresets(presetRoot, dshHome) 对 initial/stable/latest 三线各生成一个 per-line
// 预设目录计划（不写盘；CLI 负责落盘）。
//
// 背景（T8.2 /mode 真实 recompose 接线）：插件按 presetIdForLine(line) → omb-v2-<line> 调用
// ctx.agentPresets.recompose 重链，但三个 per-line 预设从未部署 → recompose 恒受限（降级为会话内
// 版本线状态，文档化行为）。本模块补全部署：生成的 agent.cordis.yml **基于项目根组合文本级生成**
// （保留全部注释与工具行——B6 教训：只有 omb-v2 一行的预设是无工具会话，绝不能生成精简版），仅做两处改写：
//   1. omb-v2 行 name 指向主预设编译产物：../<presetRoot 目录名>/lib/runtime/plugin.js?v=<原v值>
//      （行 name 相对本组合目录解析 → 相对上级目录引用主预设编译产物，保持原 ?v= 缓存尾缀）；
//   2. omb-v2 行 config 注入 line: <line>（插件据此固定本线初始版本线）。
// cognitiveRoot 保持 'workspace/.omb' 不动（插件 resolveConfigPath 相对插件文件所在根解析 → 仍指向
// 主预设共享数据——「线切换只换版本状态、数据共享」）。锚点定位用字符串断言：找不到 → 抛错（fail-loud）。
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const LINE_PRESETS = ['initial', 'stable', 'latest'] as const;
export type LinePreset = (typeof LINE_PRESETS)[number];

export interface LinePresetFile {
  name: string;
  content: string;
}

export interface LinePresetPlan {
  /** per-line 预设目录（<dshHome>/.agent-presets/omb-v2-<line>/） */
  dir: string;
  files: LinePresetFile[];
}

const PRESET_YML = 'preset.yml';
const AGENT_CORDIS = 'agent.cordis.yml';
/** omb-v2 行锚点（根组合顶层列表项，行首无缩进） */
const OMB_ROW = '- id: omb-v2';
/** omb-v2 行 name 锚点前缀（name 行值以实际文件为准；?v= 尾缀原样保留） */
const PLUGIN_NAME_PREFIX = "name: './lib/runtime/plugin.js";
/** name 行完整格式（解析 ?v= 尾缀；无尾缀也合法） */
const PLUGIN_NAME_RE = /^name: '\.\/lib\/runtime\/plugin\.js(\?v=\d+)?'$/;

/** 生成标记注释（文件顶部插入；源 = 主组合路径） */
function generationMarker(sourcePath: string): string {
  return `# 本文件由 scripts/deploy-lines.ts 生成，请勿手改；源：${sourcePath}`;
}

/** per-line preset.yml 内容（显示元数据；id 来自目录名） */
function renderPresetYml(line: LinePreset): string {
  return [
    `# OMB v2 per-line 预设显示元数据（由 scripts/deploy-lines.ts 生成；id = 目录名 omb-v2-${line}）`,
    `name: 大肥鱼模式 v2（${line}线）`,
    `description: OMB v2 认知增强 preset（${line} 线；初始版本线由 config.line 固定，供 /mode recompose 重链）`,
    '',
  ].join('\n');
}

/**
 * per-line agent.cordis.yml 内容：根组合文本级生成（保留全部注释与工具行）。
 * 改写：omb-v2 行 config 注入 `line: <line>`（缩进 4 空格，与 config 子键一致）；
 * omb-v2 行 name 指向主预设编译产物（../<presetRoot 目录名>/lib/runtime/plugin.js?v=<原v值>）。
 * 锚点缺失/格式不符 → 抛错（fail-loud）。
 */
function renderAgentCordis(source: string, line: LinePreset, presetRootName: string, marker: string): string {
  const lines = source.split('\n');
  const ombIdx = lines.findIndex((l) => l.trimEnd() === OMB_ROW);
  if (ombIdx === -1) {
    throw new Error(`主组合缺少 omb-v2 行锚点 "${OMB_ROW}"（agent.cordis.yml 被改坏？）`);
  }
  // omb-v2 行块：从该行到下一个顶层列表项（行首 "- "）为止
  let blockEnd = lines.length;
  for (let i = ombIdx + 1; i < lines.length; i++) {
    if (/^- /u.test(lines[i]!)) {
      blockEnd = i;
      break;
    }
  }
  const block = lines.slice(ombIdx + 1, blockEnd);
  const relName = block.findIndex((l) => l.trimStart().startsWith(PLUGIN_NAME_PREFIX));
  if (relName === -1) {
    throw new Error(`主组合 omb-v2 行缺少 name 锚点（${PLUGIN_NAME_PREFIX}…）`);
  }
  const rawNameLine = block[relName]!;
  const nameIndent = /^[ \t]*/u.exec(rawNameLine)?.[0] ?? '';
  const nameMatch = PLUGIN_NAME_RE.exec(rawNameLine.trim());
  if (nameMatch === null) {
    throw new Error(
      `主组合 omb-v2 行 name 值格式不符（"${rawNameLine.trim()}"，期望 ${PLUGIN_NAME_PREFIX}…?v=N'）`,
    );
  }
  const vSuffix = nameMatch[1] ?? '';
  const relConfig = block.findIndex((l) => l === '  config:');
  if (relConfig === -1) {
    throw new Error('主组合 omb-v2 行缺少 config: 锚点');
  }
  const out = [...lines];
  out[ombIdx + 1 + relName] = `${nameIndent}name: '../${presetRootName}/lib/runtime/plugin.js${vSuffix}'`;
  out.splice(ombIdx + 1 + relConfig + 1, 0, `    line: ${line}`);
  return `${marker}\n\n${out.join('\n')}`;
}

/**
 * 三线部署计划（纯函数，不写盘）：initial/stable/latest 各生成一个 per-line 预设目录
 * <dshHome>/.agent-presets/omb-v2-<line>/（preset.yml + agent.cordis.yml）。
 * presetRoot = 主预设根（读取其 agent.cordis.yml 为生成源）。
 */
export function planLinePresets(presetRoot: string, dshHome: string): LinePresetPlan[] {
  const sourcePath = join(presetRoot, AGENT_CORDIS);
  let source: string;
  try {
    source = readFileSync(sourcePath, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`读取主组合失败 ${sourcePath}（${detail}）`);
  }
  const presetRootName = basename(presetRoot);
  const marker = generationMarker(sourcePath);
  return LINE_PRESETS.map((line) => ({
    dir: join(dshHome, '.agent-presets', `omb-v2-${line}`),
    files: [
      { name: PRESET_YML, content: renderPresetYml(line) },
      { name: AGENT_CORDIS, content: renderAgentCordis(source, line, presetRootName, marker) },
    ],
  }));
}
