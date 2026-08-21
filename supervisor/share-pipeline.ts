// layer 1：共享协议打包/吸收管线（架构 §13.2：签名/哈希 → schema → 本地回放 bench → 契约测试 →
// 入库已验证 → 共识回传；T6b.1 实现，T8.9 从 share.ts 拆分——CONVENTIONS §9 LOC ≤ 400）。
// 内容：stripId（内容寻址体）、packObject/unpackObject（canonical JSON + 签名头 envelope）、
// absorb（吸收管线，任一阶段失败短路 + AbsorbReport 记录失败步）。
// 依赖：PROTOCOL/RegistryAPI（share.ts 协议单一权威源，§13.1）——ESM 循环（share.ts re-export 本模块），
// 全部引用在函数体内求值（无模块求值期依赖，循环安全）。
// layer 1：仅 import node: 内置 + kernel/schemas/（IR 契约例外）+ supervisor/ 内文件。
import { canonicalJson, makeImmutableId } from '../kernel/schemas/base.js';
import { EvolutionObjectSchema, type EvolutionObject } from '../kernel/schemas/m.js';
import { PROTOCOL, type RegistryAPI } from './share.js';
import { validateSignatureFormat } from './signature.js';

/** 内容寻址体：除 id 外的全字段（M4：id=sha256(canonical(body))，同 activation.ts；publish/verify/absorb 共用） */
export function stripId(o: EvolutionObject): Omit<EvolutionObject, 'id'> {
  const body: Record<string, unknown> = { ...o };
  delete body.id;
  return body as Omit<EvolutionObject, 'id'>;
}

// ---- 打包/解包（canonical JSON + 签名头 envelope） ----

const PACK_MAGIC = 'OMB-EVOLUTION-OBJECT';
const PACK_FORMAT = 1;

/** packObject：打包（签名头 + canonical JSON）；对象不合 schema / 哈希不一致 / 空签名 → fail-loud */
export function packObject(obj: EvolutionObject, signature: string): Buffer {
  if (signature.length === 0) throw new Error('packObject: 签名为空');
  const parsed = EvolutionObjectSchema.safeParse(obj);
  if (!parsed.success) throw new Error(`packObject: schema 校验失败 — ${parsed.error.message}`);
  const o = parsed.data;
  if (makeImmutableId(canonicalJson(stripId(o))) !== o.id) {
    throw new Error('packObject: 内容哈希与 id 不一致');
  }
  const header = `${PACK_MAGIC}:${PACK_FORMAT}:${Buffer.from(signature, 'utf8').toString('base64')}`;
  return Buffer.from(`${header}\n${canonicalJson(o)}\n`, 'utf8');
}

/** unpackObject：解包（校验失败 fail-loud——格式/版本/签名/schema/内容哈希任一非法即抛错） */
export function unpackObject(buf: Buffer): { obj: EvolutionObject; signature: string } {
  const text = buf.toString('utf8');
  const nl = text.indexOf('\n');
  if (nl < 0) throw new Error('unpackObject: 非法打包格式（缺头行）');
  const header = text.slice(0, nl).trim();
  const m = /^OMB-EVOLUTION-OBJECT:(\d+):([A-Za-z0-9+/=]+)$/.exec(header);
  if (!m) throw new Error('unpackObject: 非法头（格式不匹配）');
  if (m[1] !== String(PACK_FORMAT)) throw new Error(`unpackObject: 不支持的打包格式版本: ${m[1]}`);
  const signature = Buffer.from(m[2] ?? '', 'base64').toString('utf8');
  if (signature.length === 0) throw new Error('unpackObject: 签名为空');
  let obj: EvolutionObject;
  try {
    obj = EvolutionObjectSchema.parse(JSON.parse(text.slice(nl + 1)));
  } catch (err) {
    throw new Error(`unpackObject: 对象解析/schema 校验失败（内容被篡改）— ${String(err)}`);
  }
  if (makeImmutableId(canonicalJson(stripId(obj))) !== obj.id) {
    throw new Error('unpackObject: 内容哈希不匹配（内容被篡改）');
  }
  return { obj, signature };
}

// ---- 吸收管线（§13.2：签名/哈希 → schema → 本地回放 bench → 契约测试 → 入库已验证 → 共识回传） ----

/** 吸收阶段记录 */
export interface AbsorbStage {
  name: string;
  ok: boolean;
  detail: string;
}

/** 吸收管线依赖（注入；supervisor 不 import runtime——层 DAG） */
export interface AbsorbDeps {
  /** 验证链（T5.2 注入：谱系/信任/验证证书链） */
  verifyChain(obj: EvolutionObject): Promise<{ ok: boolean; detail: string }>;
  /** 本地回放 bench（§9.2 注入：确定性回放验证） */
  replayBench(obj: EvolutionObject): Promise<{ ok: boolean; detail: string }>;
  /** 契约测试（注入） */
  contractTests(obj: EvolutionObject): Promise<{ ok: boolean; detail: string }>;
  /** 本实例标识（共识回传 verified_by.instance；缺省 'local-instance'） */
  instance?: string;
  /** 本实例有效多样性（共识回传 verified_by.diversity；缺省 1） */
  diversity?: number;
}

/** 吸收结果报告（ok/failed_at/各阶段记录） */
export interface AbsorbReport {
  ok: boolean;
  id: string;
  stages: AbsorbStage[];
  failed_at: string | null;
}

/** 吸收管线（全纯代码，任一阶段失败短路，后续不被调） */
export async function absorb(
  registry: RegistryAPI,
  obj: EvolutionObject,
  signature: string,
  deps: AbsorbDeps,
): Promise<AbsorbReport> {
  const stages: AbsorbStage[] = [];
  const fail = (name: string, detail: string): AbsorbReport => {
    stages.push({ name, ok: false, detail });
    return { ok: false, id: obj.id, stages, failed_at: name };
  };

  // ① 签名/哈希（本地纯校验，T8.9 格式门 + fail-loud）
  if (makeImmutableId(canonicalJson(stripId(obj))) !== obj.id) return fail('signature_hash', '内容哈希与 id 不一致');
  const sigFmt = validateSignatureFormat(signature);
  if (!sigFmt.ok) return fail('signature_hash', `签名格式非法（${sigFmt.detail}）`);
  stages.push({ name: 'signature_hash', ok: true, detail: '签名/哈希校验通过' });

  // ② schema（M4 schema + 协议注册表门禁——不合格对象进不了共享池，§13.1）
  const parsed = EvolutionObjectSchema.safeParse(obj);
  if (!parsed.success) return fail('schema', `schema 校验失败: ${parsed.error.message}`);
  if (!(Object.values(PROTOCOL.schema_versions) as string[]).includes(parsed.data.schema)) {
    return fail('schema', `schema 未注册于协议: ${parsed.data.schema}`);
  }
  stages.push({ name: 'schema', ok: true, detail: `schema 通过: ${parsed.data.schema}` });

  // ③ 验证链（注入）
  const chain = await deps.verifyChain(parsed.data);
  if (!chain.ok) return fail('verify_chain', chain.detail);
  stages.push({ name: 'verify_chain', ok: true, detail: chain.detail });

  // ④ 本地回放 bench
  const replay = await deps.replayBench(parsed.data);
  if (!replay.ok) return fail('replay_bench', replay.detail);
  stages.push({ name: 'replay_bench', ok: true, detail: replay.detail });

  // ⑤ 契约测试
  const contract = await deps.contractTests(parsed.data);
  if (!contract.ok) return fail('contract_tests', contract.detail);
  stages.push({ name: 'contract_tests', ok: true, detail: contract.detail });

  // ⑥ 入库已验证（registry.publish；去重命中（内容哈希已存在，duplicate）视为已入库，继续 consensus——多实例共识累积，§10.2）
  const pub = await registry.publish(parsed.data, signature);
  if (!pub.ok && !pub.duplicate) return fail('publish', pub.error ?? '发布失败');
  stages.push({
    name: 'publish',
    ok: true,
    detail: pub.ok ? '对象入库（内容寻址）' : '去重命中（内容哈希已存在，继续共识累积）',
  });

  // ⑦ 共识回传（verified_by += 本实例，写回 registry）
  const consensus = await registry.addVerification(parsed.data.id, {
    instance: deps.instance ?? 'local-instance',
    diversity: deps.diversity ?? 1,
  });
  if (!consensus.ok) return fail('consensus', consensus.detail);
  stages.push({ name: 'consensus', ok: true, detail: consensus.detail });

  return { ok: true, id: parsed.data.id, stages, failed_at: null };
}
