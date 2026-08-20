// T0.1 行为测试：层 DAG lint（自定义 eslint 规则 omb/no-cross-layer-import）。
// 用真实 ESLint Node API + 真实 eslint.config.mjs 跑真实配置（不 mock）。
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const RULE_ID = 'omb/no-cross-layer-import';

function createEslint(): ESLint {
  return new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
}

/** filePath 决定源文件所在层；layer 取 substrate/supervisor/kernel/runtime/memory/components */
function layerPath(layer: string): string {
  return path.resolve(layer, 'x.ts');
}

async function lintRuleMessages(code: string, filePath: string): Promise<string[]> {
  const eslint = createEslint();
  const results = await eslint.lintText(code, { filePath });
  const result = results[0];
  if (!result) {
    throw new Error('ESLint 未返回结果');
  }
  return result.messages.filter((m) => m.ruleId === RULE_ID).map((m) => m.message);
}

describe('no-cross-layer-import（层 DAG lint）', () => {
  it('substrate(0) 内 import supervisor(1) → 报错', async () => {
    const msgs = await lintRuleMessages("import '../supervisor/x.js';", layerPath('substrate'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain('layer 0');
    expect(msgs[0]).toContain('layer 1');
  });

  it('substrate(0) 内 import 同层文件 → 无错', async () => {
    const msgs = await lintRuleMessages("import './ok.js';", layerPath('substrate'));
    expect(msgs).toHaveLength(0);
  });

  it('supervisor(1) 内 import kernel(2) → 报错', async () => {
    const msgs = await lintRuleMessages("import '../kernel/x.js';", layerPath('supervisor'));
    expect(msgs).toHaveLength(1);
  });

  it('supervisor(1) 内 import substrate(0)（反向依赖，合法）→ 无错', async () => {
    const msgs = await lintRuleMessages("import '../substrate/x.js';", layerPath('supervisor'));
    expect(msgs).toHaveLength(0);
  });

  it('runtime(2) 内 import components(3) → 报错', async () => {
    const msgs = await lintRuleMessages("import '../components/x.js';", layerPath('runtime'));
    expect(msgs).toHaveLength(1);
  });

  it('components(3) 内 import runtime(2)（合法）→ 无错', async () => {
    const msgs = await lintRuleMessages("import '../runtime/x.js';", layerPath('components'));
    expect(msgs).toHaveLength(0);
  });

  it('tests/ 内文件 import 任意层 → 豁免无错', async () => {
    const msgs = await lintRuleMessages(
      "import '../../substrate/x.js';",
      path.resolve('tests', 'm0', 'x.ts'),
    );
    expect(msgs).toHaveLength(0);
  });

  it('bare import（vitest）→ 豁免无错', async () => {
    const msgs = await lintRuleMessages("import { test } from 'vitest';", layerPath('substrate'));
    expect(msgs).toHaveLength(0);
  });

  it('普通语法错误不触发本规则（规则只报自己的错）', async () => {
    const msgs = await lintRuleMessages("import { from 'vitest';", layerPath('substrate'));
    expect(msgs).toHaveLength(0);
  });
});
