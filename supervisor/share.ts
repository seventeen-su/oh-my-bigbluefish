// OMB v2 集体演化协议（架构 §13 共享与集体演化 / §10.2 验证多样性 / §17 Registry transport 开放项；施工计划 T6b.1）：layer 1。
// 设计（brief 已定 + 实现选择）：protocol.json = 协议/schema 版本单一权威源（§13.1）；Registry 最小实现 = Git 清单
//   transport（本地目录 registry：protocol.json + manifest.json + objects/<hex>.json + blacklist.json，生产约定
//   workspace/.omb/.evolution/registry/）；RegistryAPI = brief 五方法 + addVerification（共识回传写路径，brief 管线要求）。
// T8.9 升级：① manifest/blacklist/objects 原子写（tmp+rename，T6b.1 缓办项——中断不半文件）；
//   ② §13.2 冲突（同逻辑身份 name+version 双候选 Pareto branch——registry 允许双候选共存 + conflict_with 标记）；
//   ③ 签名从空串升级为格式校验（git:<signer>:<keyid-hex>:<base64> / ssh:<base64>）+ 真实 Git 签名校验
//     （verifyGitSignature：git verify-tag 真实验签；环境无 GPG/SSH 密钥 → 格式校验 + 文档化限制，如实记录）。
// 吸收管线（全纯代码）：signature_hash → schema（M4 + 协议注册表门禁）→ verify_chain → replay_bench → contract_tests
//   → publish（入库已验证）→ consensus（共识回传），任一失败短路 + AbsorbReport 记录失败步。
// layer 1：仅 import node: 内置 + kernel/schemas/（IR 契约例外）+ supervisor/ 内文件。
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJson, isValidId, makeImmutableId } from '../kernel/schemas/base.js';
import { EvolutionObjectSchema, type EvolutionObject } from '../kernel/schemas/m.js';
import { GIT_BIN } from '../substrate/snapshot.js';

// ---- 协议层（§13.1：protocol.json = 协议/schema 版本单一权威源） ----

/** 协议版本（protocol.json.protocol_version） */
export const PROTOCOL_VERSION = 1;

/** 默认协议（registry 初始化时落盘 protocol.json） */
export const PROTOCOL = {
  protocol_version: PROTOCOL_VERSION,
  schema_versions: { evolution_object: 'omb/M4' },
  objects: ['evolution_object'],
} as const;

/** protocol.json schema（版本号字面量——单一权威源） */
export const ProtocolSchema = z.object({
  protocol_version: z.literal(1),
  schema_versions: z.record(z.string(), z.string().min(1)),
  objects: z.array(z.string()).min(1),
});

/** 协议文件校验（fail-loud 由调用方决定；返回 ok/detail） */
export function validateProtocol(value: unknown): { ok: boolean; detail: string } {
  const r = ProtocolSchema.safeParse(value);
  return r.success ? { ok: true, detail: 'protocol.json schema 校验通过' } : { ok: false, detail: r.error.message };
}

// ---- 签名（T8.9：格式校验 + 真实 Git 签名校验） ----

/** 签名描述符格式（Git 签名初期选型，文档化）：
 *  `git:<signer>:<keyid-hex(16-64)>:<base64>` —— git 签名描述符（signer 名 + 密钥 id + base64 签名体）
 *  `ssh:<base64>` —— SSH 签名描述符
 */
const GIT_SIG_RE = /^git:[A-Za-z0-9][A-Za-z0-9._-]*:[0-9a-f]{16,64}:[A-Za-z0-9+/=]+$/;
const SSH_SIG_RE = /^ssh:[A-Za-z0-9+/=]+$/;

/** 签名格式校验（T8.9 格式门：伪造/空串/乱码 → 拒绝；publish/verify/absorb 共用） */
export function validateSignatureFormat(signature: string): { ok: boolean; detail: string } {
  if (typeof signature !== 'string' || signature.length === 0) {
    return { ok: false, detail: '签名为空' };
  }
  if (GIT_SIG_RE.test(signature)) {
    return { ok: true, detail: 'git 签名描述符格式通过' };
  }
  if (SSH_SIG_RE.test(signature)) {
    return { ok: true, detail: 'ssh 签名描述符格式通过' };
  }
  return { ok: false, detail: '签名格式非法（应为 git:<signer>:<keyid-hex>:<base64> 或 ssh:<base64>）' };
}

export interface GitSignatureVerifyOptions {
  /** 签名描述符（先过格式门） */
  signature: string;
  /** 含签名 tag 的仓库目录 */
  repoDir: string;
  /** 被验证的签名 tag 名 */
  tag: string;
  /** git 可执行文件完整路径（缺省 GIT_BIN） */
  gitBin?: string;
}

/**
 * 真实 Git 签名校验（T8.9；git verify-tag 真实验签）。
 * 环境无 GPG/SSH 签名密钥 → { ok:false, limitation:true, detail: 文档化限制 }（格式已通过，真实验签不可用，
 * 如实记录）；未签名 tag / 签名无效 → ok:false（真实失败路径）。
 */
export async function verifyGitSignature(
  opts: GitSignatureVerifyOptions,
): Promise<{ ok: boolean; detail: string; limitation?: boolean }> {
  const fmt = validateSignatureFormat(opts.signature);
  if (!fmt.ok) {
    return { ok: false, detail: fmt.detail };
  }
  try {
    execFileSync(opts.gitBin ?? GIT_BIN, ['verify-tag', opts.tag], {
      cwd: opts.repoDir,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { ok: true, detail: `git verify-tag <${opts.tag}> 通过（真实签名校验）` };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    const detail = e.stderr ? String(e.stderr).trimEnd() : '(无 stderr)';
    // 环境无 GPG/SSH 密钥 → 文档化限制（gpg/ssh 进程级失败，非签名内容失败）
    if (/(gpg|ssh)/i.test(detail)) {
      return {
        ok: false,
        limitation: true,
        detail: `真实 git 验签不可用（环境无 GPG/SSH 签名密钥，文档化限制；格式校验已通过）：${detail}`,
      };
    }
    return { ok: false, detail: `git verify-tag <${opts.tag}> 失败（签名无效/未签名）：${detail}` };
  }
}

// ---- Registry 数据与 API（§13.2：manifest / Registry API / 去重 / 撤销） ----

/** 共识回传记录（verified_by[] 元素：实例 + 其有效多样性，§10.2） */
export interface VerificationRecord {
  instance: string;
  diversity: number;
}
/** 撤销标记（registry 标记 + 本地黑名单） */
export interface RevokeMarker {
  reason: string;
  at: string;
}
/** manifest.json 对象清单条目 */
export interface ManifestEntry {
  id: string;
  name: string;
  version: string;
  signature: string;
  parent: string | null;
  verified_by: VerificationRecord[];
  revoked?: RevokeMarker;
  /** T8.9 §13.2 冲突（双候选 Pareto branch）：同逻辑身份（name+version）的其它候选 id 列表 */
  conflict_with?: string[];
  published_at: string;
}
/** Registry API（Git 清单 transport 最小实现；addVerification = 共识回传写路径） */
export interface RegistryAPI {
  list(): Promise<ManifestEntry[]>;
  get(id: string): Promise<EvolutionObject | null>;
  publish(
    obj: EvolutionObject,
    signature: string,
    meta?: { name?: string; version?: string },
  ): Promise<{ ok: boolean; error?: string; duplicate?: boolean }>;
  verify(id: string, opts?: { gitRepo?: string; signatureTag?: string }): Promise<{ ok: boolean; detail: string; limitation?: boolean }>;
  revoke(id: string, reason: string): Promise<void>;
  addVerification(id: string, record: VerificationRecord): Promise<{ ok: boolean; detail: string }>;
}
/** 内容寻址体：除 id 外的全字段（M4：id=sha256(canonical(body))，同 activation.ts） */
function stripId(o: EvolutionObject): Omit<EvolutionObject, 'id'> {
  const body: Record<string, unknown> = { ...o };
  delete body.id;
  return body as Omit<EvolutionObject, 'id'>;
}

/** Git 清单 transport：本地目录 registry（manifest.json + objects/<hex>.json + blacklist.json + protocol.json） */
export class GitRegistry implements RegistryAPI {
  private readonly root: string;
  private readonly objectsDir: string;
  private readonly manifestFile: string;
  private readonly blacklistFile: string;
  private manifest: ManifestEntry[] = [];
  private blacklist = new Map<string, RevokeMarker>();
  private ready = false;

  constructor(root: string) {
    this.root = root;
    this.objectsDir = join(root, 'objects');
    this.manifestFile = join(root, 'manifest.json');
    this.blacklistFile = join(root, 'blacklist.json');
  }

  /** 初始化（幂等）：目录 + protocol.json + manifest.json + blacklist.json 就位并加载 */
  async init(): Promise<void> {
    if (this.ready) return;
    this.ready = true;
    await mkdir(this.objectsDir, { recursive: true });
    await this.ensureFile(join(this.root, 'protocol.json'), JSON.stringify(PROTOCOL, null, 2));
    await this.ensureFile(this.manifestFile, '[]');
    await this.ensureFile(this.blacklistFile, '{}');
    this.manifest = await this.readJson<ManifestEntry[]>(this.manifestFile, []);
    const bl = await this.readJson<Record<string, RevokeMarker>>(this.blacklistFile, {});
    this.blacklist = new Map(Object.entries(bl));
  }

  async list(): Promise<ManifestEntry[]> {
    await this.init();
    return this.manifest.map((e) => ({ ...e, verified_by: [...e.verified_by] }));
  }

  async get(id: string): Promise<EvolutionObject | null> {
    await this.init();
    if (!isValidId(id) || this.blacklist.has(id)) return null;
    const entry = this.manifest.find((e) => e.id === id);
    if (!entry || entry.revoked) return null;
    try {
      const raw = await readFile(this.objectFile(id), 'utf8');
      const obj = EvolutionObjectSchema.parse(JSON.parse(raw));
      // CAS 绑定：文件名 = 内容地址（obj.id 必须等于请求 id；A 地址被替换为自洽对象 B 时此处检出 swap 篡改）
      if (obj.id !== id) return null;
      return obj;
    } catch {
      return null;
    }
  }

  /** publish：schema → 内容哈希 → 签名（T8.9 格式门）→ 黑名单 → 去重（内容哈希已存在 → 拒绝并标
   * duplicate——absorb 视为已入库继续共识）→ 冲突标记（§13.2 双候选 Pareto branch：显式 name 时
   * 同 name+version 既有条目双向 conflict_with 标记，双候选共存）→ 落盘（原子写）+ manifest 记录 */
  async publish(
    obj: EvolutionObject,
    signature: string,
    meta?: { name?: string; version?: string },
  ): Promise<{ ok: boolean; error?: string; duplicate?: boolean }> {
    await this.init();
    const parsed = EvolutionObjectSchema.safeParse(obj);
    if (!parsed.success) return { ok: false, error: `schema 校验失败: ${parsed.error.message}` };
    const o = parsed.data;
    if (makeImmutableId(canonicalJson(stripId(o))) !== o.id) {
      return { ok: false, error: '内容哈希与 id 不一致' };
    }
    const sig = validateSignatureFormat(signature);
    if (!sig.ok) return { ok: false, error: `签名格式非法（${sig.detail}）` };
    if (this.blacklist.has(o.id)) return { ok: false, error: `对象已被撤销（本地黑名单）: ${o.id}` };
    if (this.manifest.some((e) => e.id === o.id)) {
      return { ok: false, error: `重复发布（内容哈希已存在）: ${o.id}`, duplicate: true };
    }
    // §13.2 冲突（双候选 Pareto branch）：显式 name 时，同 name+version 的既有条目 → 双向标记（共存不互斥）
    const conflictWith: string[] = [];
    if (meta?.name !== undefined) {
      const version = meta.version ?? o.protocol_version;
      for (const e of this.manifest) {
        if (e.revoked) {
          continue;
        }
        if (e.name === meta.name && e.version === version) {
          conflictWith.push(e.id);
        }
      }
    }
    await this.atomicWrite(this.objectFile(o.id), JSON.stringify(o, null, 2));
    const entry: ManifestEntry = {
      id: o.id,
      name: meta?.name ?? 'evolution-object',
      version: meta?.version ?? o.protocol_version,
      signature,
      parent: o.parent ?? null,
      verified_by: [],
      published_at: new Date().toISOString(),
      ...(conflictWith.length > 0 ? { conflict_with: conflictWith } : {}),
    };
    if (conflictWith.length > 0) {
      // 反向标记：既有候选 conflict_with += 新 id（Pareto branch 双方可见）
      for (const e of this.manifest) {
        if (conflictWith.includes(e.id)) {
          e.conflict_with = [...new Set([...(e.conflict_with ?? []), o.id])];
        }
      }
    }
    this.manifest.push(entry);
    await this.writeJson(this.manifestFile, this.manifest);
    return { ok: true };
  }

  /** verify：签名/哈希/schema 校验（任一非法 → ok:false + detail；含撤销/黑名单 fail-loud） */
  async verify(
    id: string,
    opts?: { gitRepo?: string; signatureTag?: string },
  ): Promise<{ ok: boolean; detail: string; limitation?: boolean }> {
    await this.init();
    if (!isValidId(id)) return { ok: false, detail: `非法 id: ${id}` };
    const revoked = this.blacklist.get(id);
    if (revoked) return { ok: false, detail: `对象已撤销: ${revoked.reason}` };
    const entry = this.manifest.find((e) => e.id === id);
    if (!entry) return { ok: false, detail: `对象不存在: ${id}` };
    if (entry.revoked) return { ok: false, detail: `对象已撤销: ${entry.revoked.reason}` };
    let obj: EvolutionObject;
    try {
      obj = EvolutionObjectSchema.parse(JSON.parse(await readFile(this.objectFile(id), 'utf8')));
    } catch (err) {
      return { ok: false, detail: `对象文件读取/schema 校验失败: ${String(err)}` };
    }
    if (makeImmutableId(canonicalJson(stripId(obj))) !== obj.id) {
      return { ok: false, detail: '内容哈希与 id 不一致（对象被篡改）' };
    }
    // CAS 绑定：对象文件内容地址必须等于请求 id（A 地址被替换为自洽对象 B 时内容自洽校验可绕过，此处检出 swap 篡改）
    if (obj.id !== id) {
      return { ok: false, detail: `对象文件内容地址与请求 id 不一致（swap 篡改）: ${obj.id} ≠ ${id}` };
    }
    const sig = validateSignatureFormat(entry.signature);
    if (!sig.ok) return { ok: false, detail: `签名格式非法（${sig.detail}）` };
    if (opts?.gitRepo !== undefined && opts?.signatureTag !== undefined) {
      const real = await verifyGitSignature({
        signature: entry.signature,
        repoDir: opts.gitRepo,
        tag: opts.signatureTag,
      });
      if (!real.ok) {
        return { ok: false, detail: real.detail, ...(real.limitation === true ? { limitation: true as const } : {}) };
      }
    }
    return { ok: true, detail: '签名/哈希/schema 校验通过' };
  }

  /** revoke：manifest 标记 + 本地黑名单落盘（fail-loud：get/verify/publish/addVerification 全部拒绝） */
  async revoke(id: string, reason: string): Promise<void> {
    await this.init();
    const entry = this.manifest.find((e) => e.id === id);
    if (!entry) throw new Error(`GitRegistry.revoke: 对象不存在: ${id}`);
    const marker: RevokeMarker = { reason, at: new Date().toISOString() };
    entry.revoked = marker;
    this.blacklist.set(id, marker);
    await this.writeJson(this.manifestFile, this.manifest);
    await this.writeJson(this.blacklistFile, Object.fromEntries(this.blacklist));
  }

  /** addVerification：共识回传（verified_by += 本实例；同实例幂等 no-op） */
  async addVerification(id: string, record: VerificationRecord): Promise<{ ok: boolean; detail: string }> {
    await this.init();
    const entry = this.manifest.find((e) => e.id === id);
    if (!entry) return { ok: false, detail: `对象不存在: ${id}` };
    if (entry.revoked || this.blacklist.has(id)) return { ok: false, detail: '对象已撤销，拒绝共识回传' };
    if (entry.verified_by.some((r) => r.instance === record.instance)) {
      return { ok: true, detail: '本实例验证已记录（幂等）' };
    }
    entry.verified_by.push(record);
    await this.writeJson(this.manifestFile, this.manifest);
    return { ok: true, detail: '共识回传已写入 verified_by' };
  }

  /** objects/<64hex>.json 路径 */
  private objectFile(id: string): string {
    return join(this.objectsDir, `${id.slice('sha256:'.length)}.json`);
  }
  /** 读 JSON（缺失/损坏 → fallback） */
  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }
  /** 写 JSON（manifest/blacklist/对象文件；T8.9 原子写：tmp + rename——中断不半文件） */
  private async writeJson(file: string, value: unknown): Promise<void> {
    await this.atomicWrite(file, JSON.stringify(value, null, 2));
  }

  /** 原子写（tmp+rename）：写临时文件后 rename 覆盖（§11.3 crash consistency 同款语义） */
  private async atomicWrite(file: string, content: string): Promise<void> {
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
  }
  /** 文件已存在则跳过（防覆盖已有协议/清单） */
  private async ensureFile(file: string, content: string): Promise<void> {
    try {
      await readFile(file, 'utf8');
    } catch {
      await writeFile(file, content, 'utf8');
    }
  }
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

// ---- §10.2 有效多样性 + 信誉等级 ----

/** 多样性实例（模型家族/版本/环境/OS/工具链/任务分布/基准分区） */
export interface DiversityInstance {
  model_family?: string;
  model_version?: string;
  os?: string;
  toolchain?: string;
  task_distribution?: string;
  bench_partition?: string;
}
/** 相关性加权初值：不同 (model_family, os, toolchain) 组合每个计 1（§17 待标定——冻结基准集产出后修正） */
export const DIVERSITY_COMBO_WEIGHT = 1;
/** effective_diversity：不同 (model_family, os, toolchain) 组合计数加权；同组合只算 1（§10.2，非 count(instances)） */
export function computeEffectiveDiversity(instances: DiversityInstance[]): number {
  const combos = new Set<string>();
  for (const inst of instances) {
    combos.add(JSON.stringify([inst.model_family ?? '', inst.os ?? '', inst.toolchain ?? '']));
  }
  return combos.size * DIVERSITY_COMBO_WEIGHT;
}
/** 信誉等级（§10.2：unverified → locally-verified → community-verified → high-trust） */
export type ReputationLevel = 'unverified' | 'locally-verified' | 'community-verified' | 'high-trust';
/** 信誉门槛常量表（§10.2，数据可演化；初值待标定——冻结基准集产出后修正） */
export const REPUTATION_THRESHOLDS = {
  locally_verified_min_verifications: 1,
  community_verified_min_diversity: 3,
  high_trust_min_instances: 3,
} as const;
/** 信誉等级判定：≥1 验证 → locally-verified；有效多样性 ≥ 门槛 → community-verified；跨环境多实例 → high-trust */
export function reputation(verifiedBy: VerificationRecord[]): ReputationLevel {
  if (verifiedBy.length < REPUTATION_THRESHOLDS.locally_verified_min_verifications) return 'unverified';
  const distinctInstances = new Set(verifiedBy.map((r) => r.instance));
  const totalDiversity = verifiedBy.reduce((sum, r) => sum + Math.max(0, r.diversity), 0);
  if (distinctInstances.size >= REPUTATION_THRESHOLDS.high_trust_min_instances) return 'high-trust';
  if (totalDiversity >= REPUTATION_THRESHOLDS.community_verified_min_diversity) return 'community-verified';
  return 'locally-verified';
}
