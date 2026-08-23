// 三线部署核心测试（scripts/deploy-lines-core.ts planLinePresets；developer tooling）。
// 纯核心测试（仿 tests/m7/bench-report.test.ts 的纯核心模式）：不 spawn CLI、不写盘——直接断言
// planLinePresets 返回的目录计划内容：
//   ① 三线齐全（initial/stable/latest → omb-v2-<line> 目录）；
//   ② preset.yml 名称含对应线名；
//   ③ agent.cordis.yml 含全部工具行标识（B6 教训：不能生成只有 omb-v2 一行的精简版）；
//   ④ omb-v2 行 config 含 line: <line>；
//   ⑤ omb-v2 行 name 指向 ../<presetRoot 名>/lib/runtime/plugin.js 且保留原 ?v= 值；
//   ⑥ cognitiveRoot 保持 'workspace/.omb' 不动（线切换只换版本状态、数据共享）；
//   ⑦ 含生成标记注释；锚点缺失（构造坏输入）→ 抛错（fail-loud）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planLinePresets } from '../../scripts/deploy-lines.js';

const PRESET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DSH_HOME = join(tmpdir(), 'omb-deploy-lines-test-home');

/** 按线取计划（目录 = <dshHome>/.agent-presets/omb-v2-<line>） */
function planFor(plans: ReturnType<typeof planLinePresets>, line: string): (typeof plans)[number] {
  const plan = plans.find((p) => p.dir === join(DSH_HOME, '.agent-presets', `omb-v2-${line}`));
  expect(plan, `omb-v2-${line} 预设计划应存在`).toBeDefined();
  return plan!;
}

/** 计划内取文件内容 */
function fileContent(plan: ReturnType<typeof planLinePresets>[number], name: string): string {
  const f = plan.files.find((x) => x.name === name);
  expect(f, `计划应含 ${name}`).toBeDefined();
  return f!.content;
}

describe('T8.30 planLinePresets 三线部署计划（纯函数，不写盘）', () => {
  it('① 三线齐全：initial/stable/latest → <dshHome>/.agent-presets/omb-v2-<line>/（preset.yml + agent.cordis.yml）', () => {
    const plans = planLinePresets(PRESET_ROOT, DSH_HOME);
    expect(plans.map((p) => p.dir)).toEqual([
      join(DSH_HOME, '.agent-presets', 'omb-v2-initial'),
      join(DSH_HOME, '.agent-presets', 'omb-v2-stable'),
      join(DSH_HOME, '.agent-presets', 'omb-v2-latest'),
    ]);
    for (const plan of plans) {
      expect(plan.files.map((f) => f.name).sort()).toEqual(['agent.cordis.yml', 'preset.yml']);
    }
  });

  it('② preset.yml：name 含对应线名（大肥鱼模式 v2（<line>线））+ 简要描述', () => {
    const plans = planLinePresets(PRESET_ROOT, DSH_HOME);
    for (const line of ['initial', 'stable', 'latest']) {
      const content = fileContent(planFor(plans, line), 'preset.yml');
      expect(content).toContain(`name: 大肥鱼模式 v2（${line}线）`);
      expect(content).toContain('description:');
    }
  });

  it('③ agent.cordis.yml 保留全部工具行标识（非精简版：B6 教训——只有 omb-v2 一行是无工具会话）', () => {
    const plans = planLinePresets(PRESET_ROOT, DSH_HOME);
    const content = fileContent(planFor(plans, 'stable'), 'agent.cordis.yml');
    for (const toolId of [
      'tool-pwsh',
      'tool-bash',
      'dsh-tool-subagent',
      'dsh-tool-workflow',
      'dsh-plan-mode',
      'tool-ask-user',
      'tool-todo',
      'tool-web',
    ]) {
      expect(content).toContain(toolId);
    }
  });

  it('④ omb-v2 行 config 注入 line: <line>（缩进 4 空格，各线各自固定本线）', () => {
    const plans = planLinePresets(PRESET_ROOT, DSH_HOME);
    for (const line of ['initial', 'stable', 'latest']) {
      const content = fileContent(planFor(plans, line), 'agent.cordis.yml');
      expect(content).toContain(`    line: ${line}`);
    }
  });

  it('⑤ omb-v2 行 name 指向 ../<presetRoot 名>/lib/runtime/plugin.js 且保留原 ?v= 值与缩进', () => {
    // 从根组合提取真实 ?v= 值（生成内容应保持原值，不因部署而变）
    const source = readFileSync(join(PRESET_ROOT, 'agent.cordis.yml'), 'utf8');
    const v = /name: '\.\/lib\/runtime\/plugin\.js(\?v=\d+)'/.exec(source)?.[1];
    expect(v, '根组合 omb-v2 行 name 应含 ?v= 尾缀').toBeDefined();
    const plans = planLinePresets(PRESET_ROOT, DSH_HOME);
    for (const line of ['initial', 'stable', 'latest']) {
      const content = fileContent(planFor(plans, line), 'agent.cordis.yml');
      // 相对上级目录引用主预设编译产物；保持原 ?v= 值；保留行首 2 空格缩进（YAML 块结构不被破坏）
      expect(content).toContain(`\n  name: '../${basename(PRESET_ROOT)}/lib/runtime/plugin.js${v}'\n`);
    }
  });

  it('⑥ cognitiveRoot 保持 workspace/.omb 不动（线切换只换版本状态、数据共享）', () => {
    const plans = planLinePresets(PRESET_ROOT, DSH_HOME);
    const content = fileContent(planFor(plans, 'latest'), 'agent.cordis.yml');
    expect(content).toContain("cognitiveRoot: 'workspace/.omb'");
  });

  it('⑦ 文件顶部插入生成标记注释（源 = 主组合路径）', () => {
    const plans = planLinePresets(PRESET_ROOT, DSH_HOME);
    const content = fileContent(planFor(plans, 'stable'), 'agent.cordis.yml');
    expect(content.startsWith('# 本文件由 scripts/deploy-lines.ts 生成，请勿手改；源：')).toBe(true);
    expect(content).toContain(`${join(PRESET_ROOT, 'agent.cordis.yml')}`);
  });

  it('⑧ 锚点缺失（构造坏输入：无 omb-v2 行）→ 抛错（fail-loud）', async () => {
    const badRoot = await mkdtemp(join(tmpdir(), 'omb-deploy-bad-'));
    try {
      await mkdir(badRoot, { recursive: true });
      await writeFile(
        join(badRoot, 'agent.cordis.yml'),
        '# 坏组合：缺少 omb-v2 行\n- id: tool-pwsh\n  name: "@deepseek-ai/dsh-tool-pwsh"\n',
        'utf8',
      );
      expect(() => planLinePresets(badRoot, DSH_HOME)).toThrow(/omb-v2/);
    } finally {
      await rm(badRoot, { recursive: true, force: true });
    }
  });
});
