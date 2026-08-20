// layer 0：/mode 命令的纯逻辑（不依赖 DSH，可独立测试）。
// 解析 → load 校验（fail-loud）→ 空白会话检查 → onSwitch 钩子 → 成功文本。
import type { VersionLine } from './snapshot.js';
import { VALID_LINES, isVersionLine } from './snapshot.js';

export type { VersionLine };

export interface LoadedVersion {
  tree_root: string;
  git_revision: string;
}

export interface ModeCommandDeps {
  /** 按版本线加载（校验引用存在 + 内容可读；失败应 reject） */
  load: (line: VersionLine) => Promise<LoadedVersion>;
  /** 当前生效版本线 */
  currentLine: () => string;
  /** 空白会话检查（可选；提供且非空白时拒绝切换） */
  isBlankSession?: () => Promise<boolean>;
  /** 切换钩子（真实 recompose 接线留 M0 后集成；M0 内用于记录新线） */
  onSwitch?: (line: VersionLine) => Promise<void>;
}

export interface ModeCommandResult {
  kind: 'success' | 'error';
  text: string;
}

const HELP = `合法值：${VALID_LINES.join(' | ')}`;

/**
 * /mode 命令 handler 纯逻辑：
 * - 空输入 → 返回当前模式（currentLine）+ 帮助；
 * - 未知模式 → error（消息含合法值），不触发 load；
 * - 合法模式 → load 校验（失败返回 error 文本）→ 空白会话检查（若提供且非空白 → error）
 *   → onSwitch（若提供）→ success（新模式 + git_revision 前 8 位 + tree_root）。
 */
export async function modeCommandHandler(
  rawInput: string,
  deps: ModeCommandDeps,
): Promise<ModeCommandResult> {
  const line = rawInput.trim();
  if (line === '') {
    return { kind: 'success', text: `当前版本线：${deps.currentLine()}（${HELP}）` };
  }
  if (!isVersionLine(line)) {
    return { kind: 'error', text: `未知版本线 "${line}"：${HELP}` };
  }
  let loaded: LoadedVersion;
  try {
    loaded = await deps.load(line);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: 'error', text: `切换到 ${line} 失败：${detail}` };
  }
  if (deps.isBlankSession !== undefined) {
    const blank = await deps.isBlankSession();
    if (!blank) {
      return { kind: 'error', text: `切换到 ${line} 需要空白会话（当前会话已有产出，不能切换）` };
    }
  }
  if (deps.onSwitch !== undefined) {
    await deps.onSwitch(line);
  }
  return {
    kind: 'success',
    text: `已切换到版本线 ${line}（git_revision ${loaded.git_revision.slice(0, 8)}，tree_root ${loaded.tree_root}）`,
  };
}
