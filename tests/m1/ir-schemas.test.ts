// T1.1 行为测试：Semantic IR 类型与校验（架构 §4.1/§4.2/§4.3/§4.4/§7.1/§12.1）。
// 六类：① 合法样例 ② 非法样例 ③ id 工具 ④ 不可变对象语义 ⑤ OMB_OBJECTS 防漂移 ⑥ 序列化往返。
// 样例数据来自 ./ir-cases.ts（用例表）与 ./ir-samples.ts（fixtures，控制单文件 LOC，CONVENTIONS §9）。
import { describe, expect, it } from 'vitest';
import {
  ClaimSchema,
  EventSchema,
  OMB_OBJECTS,
  ProvenanceSchema,
  S4Schema,
  SkillSchema,
  SkillStackSchema,
  TaskContractSchema,
  canonicalJson,
  deriveImmutable,
  isValidId,
  makeImmutableId,
  makeMutableId,
} from '../../kernel/schemas/index.js';
import { A1_VALID, C1_VALID, SHA, S1_VALID, omit } from './ir-samples.js';
import { INVALID, VALID } from './ir-cases.js';

describe('③ id 工具（uuid / 内容哈希）', () => {
  it('makeMutableId 生成 <type>:<uuid>', () => {
    expect(makeMutableId('claim')).toMatch(
      /^claim:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('makeMutableId 两次调用互不相同', () => {
    expect(makeMutableId('claim')).not.toBe(makeMutableId('claim'));
  });

  it('makeMutableId 非法 type fail-loud', () => {
    expect(() => makeMutableId('bad type!')).toThrow();
  });

  it('makeImmutableId 同内容同 id、异内容异 id', () => {
    expect(makeImmutableId('x')).toBe(makeImmutableId('x'));
    expect(makeImmutableId('x')).not.toBe(makeImmutableId('y'));
  });

  it('makeImmutableId 输出 sha256:<64hex>', () => {
    expect(makeImmutableId('x')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('canonicalJson 键序无关（同内容 → 同 id）', () => {
    expect(canonicalJson({ a: 1, b: { c: 2 } })).toBe(canonicalJson({ b: { c: 2 }, a: 1 }));
  });

  it('isValidId 接受合法 mutable / immutable id', () => {
    expect(isValidId(makeMutableId('claim'))).toBe(true);
    expect(isValidId(makeImmutableId('x'))).toBe(true);
  });

  it('isValidId 带 type 时校验前缀', () => {
    expect(isValidId(makeMutableId('claim'), 'claim')).toBe(true);
    expect(isValidId(makeMutableId('claim'), 'task')).toBe(false);
  });

  it('isValidId 拒绝非法 id', () => {
    expect(isValidId('garbage')).toBe(false);
    expect(isValidId('')).toBe(false);
    expect(isValidId('claim:not-a-uuid')).toBe(false);
    expect(isValidId('sha256:xyz')).toBe(false);
  });
});

describe('④ 不可变对象语义（改字段 → 新 id）', () => {
  it('deriveImmutable 改字段 → 新 sha256 id，原对象不变', () => {
    const original = { ...A1_VALID };
    const before = JSON.stringify(original);
    const next = deriveImmutable(original, { content: 'changed' });
    expect(next.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(next.id).not.toBe(original.id);
    expect(next.content).toBe('changed');
    expect(JSON.stringify(original)).toBe(before);
  });

  it('deriveImmutable 无补丁 → 内容不变 → 同 id', () => {
    const derived = deriveImmutable(A1_VALID, {});
    expect(deriveImmutable(derived, {}).id).toBe(derived.id);
  });

  it('deriveImmutable 同补丁 → 确定性同 id', () => {
    expect(deriveImmutable(A1_VALID, { content: 'x' }).id).toBe(
      deriveImmutable(A1_VALID, { content: 'x' }).id,
    );
  });

  it('deriveImmutable 对可变对象 fail-loud', () => {
    expect(() => deriveImmutable(C1_VALID, { text: 'x' })).toThrow();
  });
});

describe('IRBase 统一基座（§4.1）', () => {
  it('refs 缺省为 []', () => {
    const r = ClaimSchema.parse(omit(C1_VALID, 'refs'));
    expect(r.refs).toEqual([]);
  });

  it('owner 缺省为 kernel', () => {
    const r = ClaimSchema.parse(omit(C1_VALID, 'owner'));
    expect(r.owner).toBe('kernel');
  });

  it('immutable: true 必须 sha256 id（id 语义 refine）', () => {
    expect(TaskContractSchema.safeParse({ ...S1_VALID, immutable: true }).success).toBe(false);
  });

  it('可变对象不得使用 sha256 id', () => {
    expect(TaskContractSchema.safeParse({ ...S1_VALID, id: `sha256:${SHA}` }).success).toBe(false);
  });

  it('scope 非法枚举值拒绝', () => {
    expect(TaskContractSchema.safeParse({ ...S1_VALID, scope: 'Galaxy' }).success).toBe(false);
  });
});

describe('C1 证据态全集（§14.1 原语：inferred/observed/verified）', () => {
  it('evidence_status 全集可解析（inferred/observed/verified）', () => {
    for (const v of ['inferred', 'observed', 'verified'] as const) {
      const r = ClaimSchema.parse({ ...C1_VALID, evidence_status: v });
      expect(r.evidence_status).toBe(v);
    }
  });

  it('evidence_status 缺省 → inferred（§14.1 默认证据态）', () => {
    const r = ClaimSchema.parse(omit(C1_VALID, 'evidence_status'));
    expect(r.evidence_status).toBe('inferred');
  });

  it('evidence_status 非法值拒绝', () => {
    expect(ClaimSchema.safeParse({ ...C1_VALID, evidence_status: 'proven' }).success).toBe(false);
  });
});

describe('⑤ OMB_OBJECTS 防漂移清单（编号固定）', () => {
  const EXPECTED = [
    'A1', 'A2', 'A3', 'A4',
    'C1', 'C10', 'C11', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9',
    'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8',
    'P1', 'P2', 'P3', 'P4', 'P5',
    'S1', 'S2', 'S3', 'S4',
  ];

  it('编号集合完整（28 核心 + 4 一等，架构 §4.2/§4.3 枚举全量）', () => {
    expect(Object.keys(OMB_OBJECTS).sort()).toEqual([...EXPECTED].sort());
  });

  it('每个编号的 schema 可解析', () => {
    for (const entry of Object.values(OMB_OBJECTS)) {
      const maybe = entry as { safeParse?: (input: unknown) => { success: boolean } };
      if (typeof maybe.safeParse === 'function') {
        const r = maybe.safeParse({});
        expect(typeof r.success).toBe('boolean');
      } else {
        expect(entry).toEqual({ kind: 'interface', name: 'MemoryBackend' });
      }
    }
  });

  it('编号 → schema 身份映射正确', () => {
    expect(OMB_OBJECTS.C1).toBe(ClaimSchema);
    expect(OMB_OBJECTS.M3).toBe(EventSchema);
    expect(OMB_OBJECTS.M2).toBe(ProvenanceSchema);
    expect(OMB_OBJECTS.S4).toBe(S4Schema);
    expect(OMB_OBJECTS.P5).toBe(SkillSchema);
    expect(OMB_OBJECTS.A2).toBe(SkillStackSchema);
    expect(OMB_OBJECTS.A4).toEqual({ kind: 'interface', name: 'MemoryBackend' });
  });
});

describe('① 合法样例（全量编号）', () => {
  for (const [name, schema, sample] of VALID) {
    it(`${name} 校验通过`, () => {
      const r = schema.safeParse(sample);
      expect(r.success).toBe(true);
    });
  }
});

describe('② 非法样例（每对象 ≥1：缺必填 / 类型错 / 枚举非法值）', () => {
  for (const [name, schema, sample] of INVALID) {
    it(`${name} 被拒绝`, () => {
      const r = schema.safeParse(sample);
      expect(r.success).toBe(false);
    });
  }
});

describe('⑥ 序列化往返（JSON roundtrip）', () => {
  for (const [name, schema, sample] of VALID) {
    it(`${name} 往返一致`, () => {
      const parsed = schema.parse(sample);
      const round = schema.parse(JSON.parse(JSON.stringify(parsed)));
      expect(round).toEqual(parsed);
    });
  }
});
