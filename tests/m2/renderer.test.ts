// T2.3 行为测试：Context Compiler 与三视图投影（架构 §6.1）。
// 五步：ContentRouter 分型 → 边际价值排序 → 贪心选择 → 投影决策 → 输出 ContextProjection（确定性纯函数）。
// 十三类：① 确定性（同输入同输出） ② 分型路由（含 logs 去重） ③ 边际贪心（高入选低被裁 + 公式钉死）
//       ④ 预算耗尽停止 ⑤ marginal≤0 停止 ⑥ working_state 绝不盲压缩（逐字节一致）
//       ⑦ 三视图分组与 type 映射 ⑧ A3 schema 校验（T1.1） ⑨ 空候选
//       ⑩ 空 content 守卫（A3 契约：content 非空，入口过滤） ⑪ kind 成本参数数据化（机制即数据）
//       ⑫ ws 超预算语义（绝不压缩，允许超预算） ⑬ 同边际 tie-break（id 升序确定性）。
// fixture：真实 kernel/policy（loadPolicy，不动真实目录）+ mkdtemp 副本覆盖（改 YAML 即生效，零代码改动）。
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, type PolicyBundle } from '../../kernel/policy-loader.js';
import { ContextProjectionSchema } from '../../kernel/schemas/a.js';
import {
  compile,
  marginal,
  route,
  type CandidateItem,
  type CompileInput,
} from '../../runtime/renderer.js';

const POLICY_DIR = fileURLToPath(new URL('../../kernel/policy', import.meta.url));

let policy: PolicyBundle;
beforeAll(async () => {
  policy = await loadPolicy(POLICY_DIR);
});

/** CandidateItem 工厂（缺省：retrieval / 高价值 / planning / 预算友好；每用例显式覆盖） */
function item(over: Partial<CandidateItem> = {}): CandidateItem {
  return {
    id: 'c1',
    kind: 'retrieval',
    content: '证据内容',
    tokens: 10,
    view: 'planning',
    info_value: 100,
    source_ref: 'src:c1',
    ...over,
  };
}

/** CompileInput 工厂（缺省：无 working_state、预算充足、空候选） */
function input(over: Partial<CompileInput> = {}): CompileInput {
  return {
    task_contract: { goal: '验证 Context Compiler', success_criteria: ['确定性', '预算裁剪'] },
    candidates: [],
    budget_tokens: 4000,
    policy: policy.context,
    ...over,
  };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

/** mkdtemp fixture：复制真实 kernel/policy 目录；overrides: 文件名 → 覆盖内容（不动真实目录，CONVENTIONS §6） */
async function policyFixture(overrides: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omb-renderer-policy-'));
  roots.push(root);
  await cp(POLICY_DIR, join(root, 'policy'), { recursive: true });
  for (const [file, content] of Object.entries(overrides)) {
    await writeFile(join(root, 'policy', file), content, 'utf8');
  }
  return join(root, 'policy');
}

describe('① 确定性（同输入同输出，无随机/无时间依赖）', () => {
  it('同一输入两次 compile → 深比较完全一致（JSON 相等）', () => {
    const base = input({
      working_state: {
        goal: 'g',
        confirmed_facts: ['f1'],
        active_hypotheses: [],
        contradictions: [],
        open_questions: [],
        evidence_gaps: [],
        next_best_action: 'a',
        environment: 'win32',
      },
      candidates: [
        item({ id: 'c1', kind: 'code', content: 'const x = 1;', source_ref: 'src:code' }),
        item({ id: 'c2', kind: 'memory', content: '记忆内容 '.repeat(40), view: 'scratch', source_ref: 'src:mem' }),
        item({ id: 'c3', kind: 'artifact', view: 'evidence', source_ref: 'src:art' }),
      ],
    });
    const a = compile(base);
    const b = compile(base);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('② ContentRouter 分型', () => {
  it('各 kind → 路由策略（code→ast_marker / json→schema_marker / logs→dedup / retrieval→kept_as_evidence / memory→semantic / working_state→verbatim / artifact→pointer）', () => {
    expect(route({ kind: 'code' })).toBe('ast_marker');
    expect(route({ kind: 'json' })).toBe('schema_marker');
    expect(route({ kind: 'logs' })).toBe('dedup');
    expect(route({ kind: 'retrieval' })).toBe('kept_as_evidence');
    expect(route({ kind: 'memory' })).toBe('semantic');
    expect(route({ kind: 'working_state' })).toBe('verbatim');
    expect(route({ kind: 'artifact' })).toBe('pointer');
  });

  it('logs 去重：两条相同 logs → 只出一条 section（保留输入序首个，content 原文）', () => {
    const proj = compile(
      input({
        candidates: [
          item({ id: 'l1', kind: 'logs', content: 'INFO same', source_ref: 'src:l1' }),
          item({ id: 'l2', kind: 'logs', content: 'INFO same', source_ref: 'src:l2' }),
        ],
      }),
    );
    const logSections = proj.sections.filter((s) => s.source_ref.startsWith('src:l'));
    expect(logSections).toHaveLength(1);
    expect(logSections[0]!.source_ref).toBe('src:l1');
    expect(logSections[0]!.content).toBe('INFO same');
  });

  it('code/json 当前只打 marker 保留原文（深度 AST/schema 处理留 M2 之后）', () => {
    const proj = compile(
      input({
        candidates: [
          item({ id: 'code', kind: 'code', content: 'const x = 1;', source_ref: 'src:code' }),
          item({ id: 'json', kind: 'json', content: '{"a":1}', source_ref: 'src:json' }),
        ],
      }),
    );
    const byRef = new Map(proj.sections.map((s) => [s.source_ref, s]));
    expect(byRef.get('src:code')!.content).toBe('const x = 1;');
    expect(byRef.get('src:json')!.content).toBe('{"a":1}');
  });
});

describe('③ 边际价值贪心（marginal 降序选择，权重取 context.yaml 初值）', () => {
  it('高价值入选、低价值被裁（info_value 高/低构造）', () => {
    const proj = compile(
      input({
        candidates: [
          item({ id: 'high', kind: 'retrieval', info_value: 200, tokens: 10, source_ref: 'src:high' }),
          item({ id: 'low', kind: 'logs', info_value: 10, tokens: 100, source_ref: 'src:low' }),
        ],
      }),
    );
    const refs = proj.sections.map((s) => s.source_ref);
    expect(refs).toContain('src:high');
    expect(refs).not.toContain('src:low');
    expect(marginal(item({ id: 'high', kind: 'retrieval', info_value: 200, tokens: 10 }), policy.context)).toBeGreaterThan(0);
    expect(marginal(item({ id: 'low', kind: 'logs', info_value: 10, tokens: 100 }), policy.context)).toBeLessThanOrEqual(0);
  });

  it('marginal 公式钉死：w·info − w·token − w·reacq − w·poll − w·regr（权重与 kind 成本表均取 context.yaml 数据）', () => {
    const cand = item({ kind: 'memory', info_value: 120, tokens: 30 });
    const w = policy.context.marginal_weights;
    const costs = policy.context.kind_costs;
    const expected =
      w.info_value * cand.info_value -
      w.token_cost * cand.tokens -
      w.reacquisition * costs.reacquisition[cand.kind] -
      w.attention_pollution * costs.attention_pollution[cand.kind] -
      w.regression_risk * costs.regression_risk[cand.kind];
    expect(marginal(cand, policy.context)).toBeCloseTo(expected, 10);
  });
});

describe('④ 预算耗尽停止（total_tokens ≤ budget 且不再加入）', () => {
  it('低预算：首个高边际候选入选，下一个放不下即停止', () => {
    const proj = compile(
      input({
        budget_tokens: 40,
        candidates: [
          item({ id: 'a', kind: 'retrieval', info_value: 200, tokens: 30, source_ref: 'src:a' }),
          item({ id: 'b', kind: 'retrieval', info_value: 200, tokens: 30, source_ref: 'src:b' }),
        ],
      }),
    );
    expect(proj.total_tokens).toBeLessThanOrEqual(40);
    const refs = proj.sections.map((s) => s.source_ref);
    expect(refs).toContain('src:a');
    expect(refs).not.toContain('src:b'); // 30+30=60 > 40 → 预算耗尽停止
  });

  it('溢出即停止（非跳过继续）：后续更小候选能放下也不加入', () => {
    const proj = compile(
      input({
        budget_tokens: 40,
        candidates: [
          item({ id: 'a', kind: 'retrieval', info_value: 200, tokens: 30, source_ref: 'src:a' }),
          item({ id: 'b', kind: 'retrieval', info_value: 300, tokens: 30, source_ref: 'src:b' }),
          item({ id: 'c', kind: 'retrieval', info_value: 100, tokens: 5, source_ref: 'src:c' }),
        ],
      }),
    );
    const refs = proj.sections.map((s) => s.source_ref);
    // 排序：b > a > c；b 入选（30≤40）→ a 溢出（60>40）→ 停止——c（35≤40）不得补入
    expect(refs).toEqual(['src:b']);
    expect(proj.total_tokens).toBe(30);
    expect(proj.total_tokens).toBeLessThanOrEqual(40);
  });
});

describe('⑤ marginal ≤ 0 停止（负边际候选不被选）', () => {
  it('唯一候选负边际 → 空投影（无 section）', () => {
    const cand = item({ id: 'neg', kind: 'logs', info_value: 1, tokens: 100, source_ref: 'src:neg' });
    expect(marginal(cand, policy.context)).toBeLessThanOrEqual(0);
    const proj = compile(input({ candidates: [cand] }));
    expect(proj.sections).toHaveLength(0);
    expect(proj.total_tokens).toBe(0);
  });

  it('正边际候选入选后遇负边际（降序）→ 停止，后续不再加入', () => {
    const proj = compile(
      input({
        candidates: [
          item({ id: 'pos', kind: 'retrieval', info_value: 200, tokens: 10, source_ref: 'src:pos' }),
          item({ id: 'neg', kind: 'logs', info_value: 1, tokens: 100, source_ref: 'src:neg' }),
        ],
      }),
    );
    const refs = proj.sections.map((s) => s.source_ref);
    expect(refs).toContain('src:pos');
    expect(refs).not.toContain('src:neg');
  });
});

describe('⑥ working_state 绝不盲压缩（原文进入 planning 视图）', () => {
  it('working_state section content 与输入逐字节一致（确定性序列化），view=planning', () => {
    const ws = {
      goal: '修复回归',
      confirmed_facts: ['测试全绿是前提'],
      active_hypotheses: ['h:1'],
      contradictions: [],
      open_questions: [],
      evidence_gaps: ['缺回归复现'],
      next_best_action: '复现并修复',
      environment: 'win32',
    };
    const proj = compile(input({ working_state: ws }));
    const wsSection = proj.sections.find((s) => s.source_ref === 'working_state');
    expect(wsSection).toBeDefined();
    expect(wsSection!.content).toBe(JSON.stringify(ws)); // 逐字节一致：与输入确定性序列化完全相同
    expect(wsSection!.view).toBe('planning');
    expect(wsSection!.tokens).toBe(Math.max(1, Math.ceil(JSON.stringify(ws).length / 4)));
  });

  it('kind=working_state 候选 → verbatim 路由，content 保留原文', () => {
    const proj = compile(
      input({
        candidates: [item({ id: 'ws1', kind: 'working_state', content: 'ws 原文，绝不压缩', source_ref: 'src:ws1' })],
      }),
    );
    const s = proj.sections.find((x) => x.source_ref === 'src:ws1');
    expect(s).toBeDefined();
    expect(s!.content).toBe('ws 原文，绝不压缩');
  });
});

describe('⑦ 三视图分组与 type 映射（planning / execution_scratch / evidence_artifact）', () => {
  it('planning + scratch + evidence 候选 → 三个视图 section 组、type=mixed、按视图序分组', () => {
    const proj = compile(
      input({
        candidates: [
          item({ id: 'p1', view: 'planning', source_ref: 'src:p1' }),
          item({ id: 's1', view: 'scratch', source_ref: 'src:s1' }),
          item({ id: 'e1', view: 'evidence', source_ref: 'src:e1' }),
        ],
      }),
    );
    expect(proj.type).toBe('mixed');
    expect(proj.sections.map((s) => s.view)).toEqual(['planning', 'execution_scratch', 'evidence_artifact']);
    expect(proj.sections.map((s) => s.source_ref)).toEqual(['src:p1', 'src:s1', 'src:e1']);
  });

  it('单一视图 → 对应 type（仅 planning → planning）', () => {
    const proj = compile(input({ candidates: [item({ id: 'p1', view: 'planning', source_ref: 'src:p1' })] }));
    expect(proj.type).toBe('planning');
  });

  it('单一视图 → 对应 type（仅 scratch → execution_scratch）', () => {
    const proj = compile(input({ candidates: [item({ id: 's1', view: 'scratch', source_ref: 'src:s1' })] }));
    expect(proj.type).toBe('execution_scratch');
  });

  it('单一视图 → 对应 type（仅 evidence → evidence_artifact）', () => {
    const proj = compile(input({ candidates: [item({ id: 'e1', view: 'evidence', source_ref: 'src:e1' })] }));
    expect(proj.type).toBe('evidence_artifact');
  });
});

describe('⑧ 输出符合 A3 ContextProjection schema（T1.1）', () => {
  it('完整输入 compile 输出通过 ContextProjectionSchema 校验', () => {
    const proj = compile(
      input({
        working_state: {
          goal: 'g',
          confirmed_facts: [],
          active_hypotheses: [],
          contradictions: [],
          open_questions: [],
          evidence_gaps: [],
          next_best_action: 'a',
          environment: 'win32',
        },
        candidates: [
          item({ id: 'art', kind: 'artifact', view: 'evidence', source_ref: 'src:art' }),
          item({ id: 'mem', kind: 'memory', content: '长记忆内容 '.repeat(60), view: 'scratch', source_ref: 'src:mem' }),
        ],
      }),
    );
    const parsed = ContextProjectionSchema.safeParse(proj);
    expect(parsed.success).toBe(true);
  });

  it('immutable 对象：id 为 sha256 内容哈希；改内容 → 新 id', () => {
    const a = compile(input({ candidates: [item({ id: 'x', content: 'A', source_ref: 'src:x' })] }));
    const b = compile(input({ candidates: [item({ id: 'x', content: 'B', source_ref: 'src:x' })] }));
    expect(a.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.immutable).toBe(true);
    expect(a.deterministic).toBe(true);
  });

  it('有 artifact 候选被选 → restore_capable=true；original_artifact_ids 收集 artifact id', () => {
    const proj = compile(
      input({
        candidates: [
          item({ id: 'art-1', kind: 'artifact', view: 'evidence', source_ref: 'src:art' }),
          item({ id: 'plain', kind: 'retrieval', view: 'evidence', source_ref: 'src:plain' }),
        ],
      }),
    );
    expect(proj.restore_capable).toBe(true);
    expect(proj.original_artifact_ids).toEqual(['art-1']);
  });
});

describe('⑨ 空候选', () => {
  it('candidates 空且无 working_state → 空投影（sections 空、total_tokens 0、deterministic true）且 schema 通过', () => {
    const proj = compile(input({ candidates: [] }));
    expect(proj.sections).toEqual([]);
    expect(proj.total_tokens).toBe(0);
    expect(proj.deterministic).toBe(true);
    expect(proj.restore_capable).toBe(false);
    expect(proj.original_artifact_ids).toEqual([]);
    expect(ContextProjectionSchema.safeParse(proj).success).toBe(true);
  });
});

describe('⑩ 空 content 守卫（A3 契约：section content 非空，compile 入口过滤）', () => {
  it('空 content 候选（空日志行）→ 被过滤：输出不含该候选、其余候选照常、schema 合规', () => {
    const proj = compile(
      input({
        candidates: [
          item({ id: 'empty', kind: 'logs', content: '', source_ref: 'src:empty' }),
          item({ id: 'ok', kind: 'retrieval', content: '正常行', source_ref: 'src:ok' }),
        ],
      }),
    );
    const refs = proj.sections.map((s) => s.source_ref);
    expect(refs).not.toContain('src:empty');
    expect(refs).toContain('src:ok');
    expect(ContextProjectionSchema.safeParse(proj).success).toBe(true);
  });

  it('仅空 content 候选 → 空投影且 schema 合规', () => {
    const proj = compile(input({ candidates: [item({ id: 'e1', kind: 'memory', content: '', source_ref: 'src:e1' })] }));
    expect(proj.sections).toEqual([]);
    expect(ContextProjectionSchema.safeParse(proj).success).toBe(true);
  });
});

describe('⑪ kind 成本参数数据化（机制即数据：改 context.yaml 即生效，零代码改动）', () => {
  it('fixture context.yaml 将 reacquisition.code 改为 999 → marginal 随之变化且 compile 选择翻转', async () => {
    const dir = await policyFixture({
      'context.yaml': [
        'marginal_weights:',
        '  info_value: 1.0',
        '  token_cost: 0.5',
        '  reacquisition: 0.8',
        '  attention_pollution: 0.4',
        '  regression_risk: 0.6',
        'working_state_never_compress: true',
        'kind_costs:',
        '  reacquisition:',
        '    code: 999',
        '    json: 25',
        '    logs: 15',
        '    retrieval: 40',
        '    memory: 20',
        '    working_state: 0',
        '    artifact: 35',
        '    evidence: 40',
        '    capability: 5',
        '    process: 40',
        '  attention_pollution:',
        '    code: 15',
        '    json: 10',
        '    logs: 30',
        '    retrieval: 8',
        '    memory: 5',
        '    working_state: 5',
        '    artifact: 10',
        '    evidence: 8',
        '    capability: 5',
        '    process: 5',
        '  regression_risk:',
        '    code: 10',
        '    json: 8',
        '    logs: 12',
        '    retrieval: 5',
        '    memory: 8',
        '    working_state: 5',
        '    artifact: 6',
        '    evidence: 5',
        '    capability: 3',
        '    process: 2',
      ].join('\n'),
    });
    const p = await loadPolicy(dir);
    const cand = item({ id: 'code', kind: 'code', info_value: 200, tokens: 10, source_ref: 'src:code' });
    // 数据驱动：同公式、同代码，仅 YAML 不同 → marginal 不同
    expect(marginal(cand, p.context)).not.toBe(marginal(cand, policy.context));
    expect(p.context.kind_costs.reacquisition.code).toBe(999);
    // compile 行为随之翻转：真实策略下 code 候选入选，fixture（reacquisition=999）下被裁
    const real = compile(input({ candidates: [cand] }));
    const flips = compile(input({ policy: p.context, candidates: [cand] }));
    expect(real.sections.map((s) => s.source_ref)).toContain('src:code');
    expect(flips.sections.map((s) => s.source_ref)).not.toContain('src:code');
    // 公式按 fixture 数据复算一致（公式在代码、参数在数据）
    const w = p.context.marginal_weights;
    const costs = p.context.kind_costs;
    const expected =
      w.info_value * cand.info_value -
      w.token_cost * cand.tokens -
      w.reacquisition * costs.reacquisition[cand.kind] -
      w.attention_pollution * costs.attention_pollution[cand.kind] -
      w.regression_risk * costs.regression_risk[cand.kind];
    expect(marginal(cand, p.context)).toBeCloseTo(expected, 10);
  });
});

describe('⑫ ws 超预算语义（钉死有意语义：ws 绝不压缩，允许超预算）', () => {
  it('ws 单独超预算 → total_tokens > budget 且 ws 原文仍在、无候选入选', () => {
    const budget = 4000;
    const ws = {
      goal: 'g',
      confirmed_facts: ['x'.repeat(20000)],
      active_hypotheses: [],
      contradictions: [],
      open_questions: [],
      evidence_gaps: [],
      next_best_action: 'a',
      environment: 'win32',
    };
    const proj = compile(
      input({
        budget_tokens: budget,
        working_state: ws,
        candidates: [item({ id: 'c1', kind: 'retrieval', info_value: 200, tokens: 10, source_ref: 'src:c1' })],
      }),
    );
    const wsSection = proj.sections.find((s) => s.source_ref === 'working_state');
    expect(wsSection).toBeDefined();
    expect(wsSection!.content).toBe(JSON.stringify(ws)); // 原文逐字节一致
    expect(proj.total_tokens).toBeGreaterThan(budget); // ws 绝不压缩 → 允许超预算
    expect(proj.sections.filter((s) => s.source_ref !== 'working_state')).toHaveLength(0); // 候选预算 = max(0, budget − ws) = 0
    expect(ContextProjectionSchema.safeParse(proj).success).toBe(true);
  });
});

describe('⑬ 同边际 tie-break（确定性：id 升序）', () => {
  it('两候选 marginal 相同 → 按 id 升序入选', () => {
    const a = item({ id: 'b', kind: 'retrieval', info_value: 100, tokens: 10, view: 'planning', source_ref: 'src:b' });
    const b = item({ id: 'a', kind: 'retrieval', info_value: 100, tokens: 10, view: 'planning', source_ref: 'src:a' });
    expect(marginal(a, policy.context)).toBe(marginal(b, policy.context));
    const proj = compile(input({ candidates: [a, b] }));
    expect(proj.sections.map((s) => s.source_ref)).toEqual(['src:a', 'src:b']);
  });
});
