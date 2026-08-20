// OMB v2 Candidate Trust Pool（架构 §9.3 信任池与污染隔离 / P11；施工计划 T5.1）：layer 1。
//
// 目录契约（workspace/.omb/.evolution/ 下，本模块管理信任区记录物化）：
//   candidates/<id>/   候选工作树（T0.2 git worktree 机制，本模块不建）
//   trusted/<id>/      信任池（晋升后对象物化；消费方只读语义——本模块仅 promote/revoke 写）
//   untrusted/<id>/    未可信区（仅验证链可读/写；消费方禁止引用）
//   rejected/<id>/     被拒候选（留痕：record.json + reason.txt）
//
// 硬边界语义（§9.3）：
// - registerCandidate 一律落 untrusted/ 且 status 强制 untrusted（调用方自称更高状态无效）；
//   以未可信候选为父注册新候选 → 拒绝（G1 强制，父版本谱系检查）。
// - checkLineage 递归 parent 链（自盘上记录读取）：任一祖先 status ≠ trusted → 拒绝；
//   祖先缺失 / 链成环 → 拒绝（fail-loud，防止静默放行污染）。
// - promote 校验谱系后移入 trusted/（幂等：已 trusted → no-op；被拒候选不可晋升）。
// - assertTrusted 是消费方（Generator/Consolidator/Skill 生成器）统一守卫入口：非 trusted 抛错（fail-loud）。
//   消费方应先 load(id) 取最新记录再 assertTrusted（守卫同步检查传入记录；盘上复核在 load 时发生）。
// - revoke 撤销已晋升对象 → 后代（lineage 含被撤销 id 的已登记记录）re-suspect 回 untrusted。
// - reject 仅作用于未晋升候选（留痕 reason）；已晋升对象撤销必须走 revoke（防静默绕过 trust 语义）。
// - 谱系字段：注册时自动派生（父记录 lineage + [self]；根候选 [self]），盘上记录为权威。
//
// layer 1（supervisor/）：仅 import node: 内置（CandidateRecord 为本模块自包含契约，无需 kernel/schemas）。
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 候选状态：验证链中间态 structural/behavioral/semantic 与信任池判定态 */
export type CandidateStatus = 'untrusted' | 'structural' | 'behavioral' | 'semantic' | 'trusted' | 'rejected';

/** 候选对象类型（§9.3 对象分层：L0 数据 → L1 代码 → 哲学最高门） */
export type CandidateKind = 'memory' | 'process' | 'skill' | 'policy' | 'code';

/** 候选记录（目录契约，盘上 record.json 形状；lineage = 全链 root..self） */
export interface CandidateRecord {
  id: string; // 对象 id（sha256:<hash> 或 type:uuid）
  kind: CandidateKind;
  status: CandidateStatus;
  parent: string | null; // 父版本 id（谱系）
  lineage: string[]; // 全链（root..self）
  gates_passed: string[]; // ['G1','G2','G3',...]
  created: number;
  provenance: string; // event/provenance ref
}

/** 谱系检查结论（brief 契约：{ ok: boolean; reason?: string }；ok:false 时必有 reason） */
export type LineageVerdict = { ok: boolean; reason?: string };

const KIND_SET = new Set<CandidateKind>(['memory', 'process', 'skill', 'policy', 'code']);
const RECORD_FILE = 'record.json';
const PAYLOAD_FILE = 'payload.txt';
/** 记录区（消费方可见区 = trusted；仅验证链可读写 untrusted；rejected 留痕） */
const ZONES = ['trusted', 'untrusted', 'rejected'] as const;

/** 目录名映射：Windows 目录名不允许 ':'，剥离 `type:` 前缀（如 sha256:<64hex> → <64hex>；
 *  与 ArtifactStore 同风格——目录名用 id 的 64hex 部分）。无前缀 id 原样返回。 */
export function candidateDirName(id: string): string {
  return id.replace(/^[a-z0-9]+:/i, '');
}

export class CandidatePool {
  /** @param evolutionRoot .evolution 目录（生产 = workspace/.omb/.evolution；测试 = mkdtemp fixture） */
  constructor(private readonly evolutionRoot: string) {}

  // ---- 消费方守卫（统一入口，同步 fail-loud） ----

  /** 消费方守卫：非 trusted 抛错（§9.3 硬边界——未可信候选绝不能成为任何消费输入） */
  assertTrusted(rec: CandidateRecord): void {
    if (rec.status !== 'trusted') {
      throw new Error(
        `candidates.assertTrusted: 候选 ${rec.id} 状态为 ${rec.status}，仅 trusted 可被消费（污染隔离 §9.3）`,
      );
    }
  }

  // ---- 谱系检查（G1 强制） ----

  /** 谱系检查：递归回溯 parent 链（盘上记录为权威），任一祖先非 trusted / 缺失 / 成环 → 拒绝 */
  async checkLineage(rec: CandidateRecord): Promise<LineageVerdict> {
    if (rec.parent === null) {
      return { ok: true };
    }
    const visited = new Set<string>();
    let cur: string | null = rec.parent;
    while (cur !== null) {
      if (visited.has(cur)) {
        return { ok: false, reason: `谱系检查（G1）: 祖先链成环: ${cur}` };
      }
      visited.add(cur);
      const found = await this.findRecordWithZone(cur);
      if (found === null) {
        return { ok: false, reason: `谱系检查（G1）: 祖先 <${cur}> 不存在（父版本必须已注册）` };
      }
      if (found.rec.status !== 'trusted') {
        return {
          ok: false,
          reason: `谱系检查（G1）: 祖先 <${cur}> 状态为 ${found.rec.status}，非 trusted（未可信候选不能作父版本）`,
        };
      }
      cur = found.rec.parent;
    }
    return { ok: true };
  }

  // ---- 候选生命周期 ----

  /** 注册候选：一律落 untrusted/ 且 status 强制 untrusted；父版本谱系未过 → 拒绝（G1） */
  async registerCandidate(rec: CandidateRecord, payload?: string): Promise<void> {
    this.assertRecShape(rec);
    if (rec.parent !== null) {
      const lc = await this.checkLineage(rec);
      if (!lc.ok) {
        throw new Error(`registerCandidate: 父版本谱系检查失败（G1 强制）: ${lc.reason ?? '未知原因'}`);
      }
    }
    const existing = await this.findRecordWithZone(rec.id);
    if (existing !== null) {
      throw new Error(`registerCandidate: 候选 ${rec.id} 已注册（${existing.zone}/），id 必须唯一（内容寻址）`);
    }
    // 谱系自动派生：父记录 lineage + [self]；根候选 [self]（盘上记录为权威）
    const lineage =
      rec.parent === null
        ? rec.lineage.length > 0
          ? rec.lineage
          : [rec.id]
        : await this.deriveLineage(rec.parent, rec.id);
    const stored: CandidateRecord = { ...rec, status: 'untrusted', lineage };
    const dir = join(this.evolutionRoot, 'untrusted', candidateDirName(rec.id));
    await this.ensureZone('untrusted');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, RECORD_FILE), JSON.stringify(stored, null, 2), 'utf8');
    if (payload !== undefined) {
      await writeFile(join(dir, PAYLOAD_FILE), payload, 'utf8');
    }
  }

  /** 晋升：谱系校验通过后移入 trusted/（status 强制 trusted）；未过谱系 → 拒绝（不落 trusted/） */
  async promote(rec: CandidateRecord): Promise<void> {
    const found = await this.findRecordWithZone(rec.id);
    if (found === null) {
      throw new Error(`promote: 候选 ${rec.id} 未注册（不存在于任何信任区）`);
    }
    if (found.zone === 'trusted') {
      return; // 幂等：已晋升 no-op
    }
    if (found.zone === 'rejected') {
      throw new Error(`promote: 候选 ${rec.id} 已被拒绝，不可晋升`);
    }
    const lc = await this.checkLineage(found.rec);
    if (!lc.ok) {
      throw new Error(`promote 拒绝（谱系检查失败，G1 强制）: ${lc.reason ?? '未知原因'}`);
    }
    await this.moveRecord('untrusted', 'trusted', found.rec, (r) => ({ ...r, status: 'trusted' }));
  }

  /** 拒绝：未晋升候选移入 rejected/ 留痕（reason.txt）；已晋升对象必须走 revoke */
  async reject(rec: CandidateRecord, reason: string): Promise<void> {
    const found = await this.findRecordWithZone(rec.id);
    if (found === null) {
      throw new Error(`reject: 候选 ${rec.id} 未注册`);
    }
    if (found.zone === 'trusted') {
      throw new Error(`reject: 候选 ${rec.id} 已晋升——撤销必须走 revoke（拒绝会绕过 trust 语义）`);
    }
    if (found.zone === 'rejected') {
      return; // 幂等
    }
    const dstDir = join(this.evolutionRoot, 'rejected', candidateDirName(rec.id));
    await this.ensureZone('rejected');
    await mkdir(dstDir, { recursive: true });
    await writeFile(join(dstDir, RECORD_FILE), JSON.stringify({ ...found.rec, status: 'rejected' }, null, 2), 'utf8');
    await writeFile(join(dstDir, 'reason.txt'), reason, 'utf8');
    await rm(join(this.evolutionRoot, 'untrusted', candidateDirName(rec.id)), { recursive: true, force: true });
  }

  /** 撤销：已晋升对象回 untrusted + 后代（lineage 含该 id）re-suspect；返回受影响 id 列表 */
  async revoke(id: string): Promise<{ affected: string[] }> {
    const found = await this.findRecordWithZone(id);
    if (found === null) {
      throw new Error(`revoke: 候选 ${id} 未注册`);
    }
    if (found.zone !== 'trusted') {
      throw new Error(`revoke: 候选 ${id} 未晋升（当前 ${found.rec.status}）——仅已晋升对象可撤销`);
    }
    const affected = [id];
    const all = await this.scanRecords(['trusted', 'untrusted']);
    for (const r of all) {
      if (r.id === id) {
        continue;
      }
      if (r.lineage.includes(id)) {
        affected.push(r.id);
        if (r.status === 'trusted') {
          await this.moveRecord('trusted', 'untrusted', r, (x) => ({ ...x, status: 'untrusted' }));
        }
        // 已 re-suspect（untrusted）的后代保持 untrusted，无需动作
      }
    }
    await this.moveRecord('trusted', 'untrusted', found.rec, (x) => ({ ...x, status: 'untrusted' }));
    return { affected };
  }

  // ---- 消费方读取 ----

  /** 读取候选当前记录（盘上权威；未注册 → fail-loud）。消费方先 load 再 assertTrusted */
  async load(id: string): Promise<CandidateRecord> {
    const found = await this.findRecordWithZone(id);
    if (found === null) {
      throw new Error(`candidates.load: 候选 ${id} 未注册`);
    }
    return found.rec;
  }

  // ---- 内部工具 ----

  /** 谱系派生：父记录 lineage + [self] */
  private async deriveLineage(parentId: string, selfId: string): Promise<string[]> {
    const found = await this.findRecordWithZone(parentId);
    if (found === null) {
      throw new Error(`candidates.deriveLineage: 父候选 ${parentId} 不存在`);
    }
    return [...found.rec.lineage, selfId];
  }

  /** 记录形状校验（fail-loud） */
  private assertRecShape(rec: CandidateRecord): void {
    if (typeof rec.id !== 'string' || rec.id.length === 0) {
      throw new Error('candidates: 候选 id 缺失');
    }
    if (!KIND_SET.has(rec.kind)) {
      throw new Error(`candidates: 非法候选 kind: ${String(rec.kind)}`);
    }
    if (typeof rec.provenance !== 'string' || rec.provenance.length === 0) {
      throw new Error('candidates: 候选 provenance 缺失');
    }
  }

  /** 移动记录（含 payload）：写入目标区 record.json（经 transform）+ payload.txt，删除源区 */
  private async moveRecord(
    fromZone: string,
    toZone: string,
    rec: CandidateRecord,
    transform: (r: CandidateRecord) => CandidateRecord,
  ): Promise<void> {
    const srcDir = join(this.evolutionRoot, fromZone, candidateDirName(rec.id));
    const dstDir = join(this.evolutionRoot, toZone, candidateDirName(rec.id));
    await this.ensureZone(toZone);
    await mkdir(dstDir, { recursive: true });
    await writeFile(join(dstDir, RECORD_FILE), JSON.stringify(transform(rec), null, 2), 'utf8');
    try {
      const payload = await readFile(join(srcDir, PAYLOAD_FILE), 'utf8');
      await writeFile(join(dstDir, PAYLOAD_FILE), payload, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
    await rm(srcDir, { recursive: true, force: true });
  }

  /** 按 id 查找记录（含所在区）；跨 trusted/untrusted/rejected 扫描，损坏记录 fail-loud */
  private async findRecordWithZone(id: string): Promise<{ rec: CandidateRecord; zone: string } | null> {
    for (const zone of ZONES) {
      const path = join(this.evolutionRoot, zone, candidateDirName(id), RECORD_FILE);
      try {
        const raw = await readFile(path, 'utf8');
        return { rec: JSON.parse(raw) as CandidateRecord, zone };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw new Error(`candidates: 记录损坏（${zone}/${id}/${RECORD_FILE}）: ${(err as Error).message}`);
      }
    }
    return null;
  }

  /** 扫描指定区的全部记录（损坏记录 fail-loud；区不存在 → 空） */
  private async scanRecords(zones: readonly string[]): Promise<CandidateRecord[]> {
    const out: CandidateRecord[] = [];
    for (const zone of zones) {
      const dir = join(this.evolutionRoot, zone);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw err;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        try {
          const raw = await readFile(join(dir, entry.name, RECORD_FILE), 'utf8');
          out.push(JSON.parse(raw) as CandidateRecord);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            continue;
          }
          throw new Error(`candidates.scanRecords: 记录损坏（${zone}/${entry.name}/${RECORD_FILE}）: ${(err as Error).message}`);
        }
      }
    }
    return out;
  }

  /** 确保记录区目录存在（仅写路径调用；读路径不建目录——消费方只读零副作用） */
  private async ensureZone(zone: string): Promise<void> {
    await mkdir(join(this.evolutionRoot, zone), { recursive: true });
  }
}
