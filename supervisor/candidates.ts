// OMB v2 Candidate Trust Pool（架构 §9.3 信任池与污染隔离 / P11；施工计划 T5.1）：layer 1。
//
// 目录契约（workspace/.omb/.evolution/ 下，本模块管理信任区记录物化）：
//   candidates/<id>/   候选工作树（T0.2 git worktree 机制，本模块不建）
//   trusted/<id>/      信任池（晋升后对象物化；消费方只读语义——本模块仅 promote/revoke 写）
//   untrusted/<id>/    未可信区（仅验证链可读/写；消费方禁止引用）
//   rejected/<id>/     被拒候选（留痕：record.json + reason.txt）
//   error/<组件>/<id>/ P1e/S6 错误分支池（§3.3 error/<组件>/<id>：晋升后线上退化/回滚对象按组件
//                      归档于此——保留 record/payload/provenance + reason.txt；terminal 归档，
//                      消费方/晋升/拒绝/撤销均不可见（findRecordWithZone/counts 不扫该区）；
//                      组件归属缺省 kernel（非组件候选）；兼容旧形态 error/<id>/ 读取（S6））
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
// - markError（P1e/S6）：晋升后对象线上退化（rollbackPromotion 触发）→ 移入 error/<组件>/<id>/ 归档
//   （terminal）。组件级 error 分支语义（架构 §3.3）：自迭代内容在下次使用出错 → 该组件/对象版本
//   移动至 error/<组件>/<id>（保留完整 diff、provenance、出错信号），当前线自动回退上一稳定版本；
//   error 分支保留分析价值——修复候选从 error 分支派生，验证通过后回主链，否则永久归档（负样本）。
//   组件归属：调用方传 component → 候选 provenance.component 解析 → 缺省 kernel（非组件候选）；
//   组件级独立走线 = 目录分层 + listError(component)/errorCounts() 按组件查询（一组件 error
//   不影响其它——池本身候选级隔离，S6 补组件维度可观测性）。兼容旧形态 error/<id>/（读取双形态，
//   旧归档归属 kernel，无需一次性迁移）。
// - 谱系字段：注册时自动派生（父记录 lineage + [self]；根候选 [self]），盘上记录为权威。
//
// layer 1（supervisor/）：仅 import node: 内置（CandidateRecord 为本模块自包含契约，无需 kernel/schemas）。
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 候选状态：验证链中间态 structural/behavioral/semantic 与信任池判定态（P1e 增 error——§3.3 错误分支池） */
export type CandidateStatus = 'untrusted' | 'structural' | 'behavioral' | 'semantic' | 'trusted' | 'rejected' | 'error';

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

/** 候选 provenance 清单（§6.5.2：来源事件/动机/diff；写入 candidates/<id>/provenance.json，随记录移动） */
export interface CandidateProvenance {
  /** 来源事件 id（如 evolution/candidate 决策事件；触发本次候选的信号/事件链） */
  source_events: string[];
  /** 动机（触发信号摘要/判定理由/生成意图） */
  motivation: string;
  /** 变更 diff（P1d 填真实 diff；现为判定信息/占位） */
  diff?: Record<string, unknown> | string;
  /** 清单创建时间（epoch ms） */
  created: number;
  /** S6：组件归属声明（候选所属组件——markError 未显式传 component 时从此解析；缺省 kernel） */
  component?: string;
}

/** S6：error 池缺省组件归属（非组件候选——未显式传 component 且 provenance 未声明时的归档组件名） */
export const DEFAULT_ERROR_COMPONENT = 'kernel';

/** S6：error 池清单条目（组件归属 + 记录 + 出错信号 reason.txt；reason 缺失 → null） */
export interface ErrorRecordEntry {
  component: string;
  rec: CandidateRecord;
  reason: string | null;
}

const KIND_SET = new Set<CandidateKind>(['memory', 'process', 'skill', 'policy', 'code']);
const RECORD_FILE = 'record.json';
const PAYLOAD_FILE = 'payload.txt';
const PROVENANCE_FILE = 'provenance.json';
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

  /** 注册候选：一律落 untrusted/ 且 status 强制 untrusted；父版本谱系未过 → 拒绝（G1）。
   *  provenance（§6.5.2 清单：来源事件/动机/diff）可选——提供时写入 candidates/<id>/provenance.json。 */
  async registerCandidate(
    rec: CandidateRecord,
    payload?: string,
    provenance?: CandidateProvenance,
  ): Promise<void> {
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
    if (provenance !== undefined) {
      await writeFile(join(dir, PROVENANCE_FILE), JSON.stringify(provenance, null, 2), 'utf8');
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
    await this.copyAuxFile(
      join(this.evolutionRoot, 'untrusted', candidateDirName(rec.id)),
      dstDir,
      PROVENANCE_FILE,
    );
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

  /**
   * P1e/S6 错误分支池标记（架构 §3.3 error/<组件>/<id>，S6 实现组件级）：晋升后对象线上退化/回滚
   * （rollbackPromotion 触发）→ 移入 error/<component>/<id>/ 归档（record.json status='error' +
   * reason.txt + payload/provenance 保留——完整 diff/provenance/出错信号，负样本分析价值）。
   * 组件归属解析（最小实现，candidates 零依赖不 import 注册表）：opts.component（调用方显式）
   * → 候选 provenance.component（resolveProvenanceComponent）→ 缺省 DEFAULT_ERROR_COMPONENT
   * （'kernel'——非组件候选）。注册组件 manifest id 匹配留注册表注入面（注释声明，不虚构语义）。
   * 兼容旧形态：幂等/读取同时检查 error/<component>/<id>/ 与 error/<id>/（S6 前候选级归档）——
   * 旧归档继续可读（listError/errorCounts 归属 kernel），无需一次性迁移。
   * 语义：terminal 归档——error 区不参与 findRecordWithZone/counts（消费方/晋升/拒绝/撤销均不可见）；
   * 修复候选从 error 分支派生（验证通过后回主链）留后续施工。
   * 幂等：已归档（新形态 error/<component>/<id>/ 或旧形态 error/<id>/）→ no-op。
   */
  async markError(id: string, reason: string, opts: { component?: string } = {}): Promise<void> {
    const component = opts.component ?? (await this.resolveProvenanceComponent(id)) ?? DEFAULT_ERROR_COMPONENT;
    // 幂等早退：新形态 error/<component>/<id>/ 或旧形态 error/<id>/ 已归档 → no-op（terminal 语义）
    if (await this.archivedInError(id, component)) {
      return;
    }
    const found = await this.findRecordWithZone(id);
    if (found === null) {
      throw new Error(`markError: 候选 ${id} 未注册（不存在于 trusted/untrusted/rejected 区）`);
    }
    const dstDir = join(this.evolutionRoot, 'error', component, candidateDirName(id));
    await this.ensureZone('error');
    await mkdir(join(this.evolutionRoot, 'error', component), { recursive: true });
    await mkdir(dstDir, { recursive: true });
    await writeFile(
      join(dstDir, RECORD_FILE),
      JSON.stringify({ ...found.rec, status: 'error' }, null, 2),
      'utf8',
    );
    await writeFile(join(dstDir, 'reason.txt'), reason, 'utf8');
    await this.copyAuxFile(join(this.evolutionRoot, found.zone, candidateDirName(id)), dstDir, PAYLOAD_FILE);
    await this.copyAuxFile(join(this.evolutionRoot, found.zone, candidateDirName(id)), dstDir, PROVENANCE_FILE);
    await rm(join(this.evolutionRoot, found.zone, candidateDirName(id)), { recursive: true, force: true });
  }

  /**
   * S6：error 池清单（组件级独立走线的可观测性；按组件过滤）。兼容双形态：旧形态 error/<id>/
   * （S6 前候选级归档）→ 归属 DEFAULT_ERROR_COMPONENT（kernel——非组件候选）；新形态
   * error/<component>/<id>/ → 归属组件名。只读（读路径不建目录——error 区不存在 → 空）。
   */
  async listError(component?: string): Promise<ErrorRecordEntry[]> {
    const out: ErrorRecordEntry[] = [];
    let entries;
    try {
      entries = await readdir(join(this.evolutionRoot, 'error'), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return out; // error 区不存在 → 空（只读路径不建目录）
      }
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = join(this.evolutionRoot, 'error', entry.name);
      // 旧形态 error/<id>/：目录直接含 record.json → 非组件候选（归属 kernel）
      const legacy = await this.readErrorRecord(dir);
      if (legacy !== null) {
        if (component === undefined || component === DEFAULT_ERROR_COMPONENT) {
          out.push({ component: DEFAULT_ERROR_COMPONENT, rec: legacy, reason: await this.readReasonText(dir) });
        }
        continue;
      }
      // 新形态 error/<component>/<id>/：子目录各含 record.json（组件名 = entry.name）
      if (component !== undefined && component !== entry.name) {
        continue;
      }
      let children;
      try {
        children = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // 子目录不可读（竞争/损坏）→ 跳过该组件
      }
      for (const child of children) {
        if (!child.isDirectory()) {
          continue;
        }
        const childDir = join(dir, child.name);
        const rec = await this.readErrorRecord(childDir);
        if (rec !== null) {
          out.push({ component: entry.name, rec, reason: await this.readReasonText(childDir) });
        }
      }
    }
    return out;
  }

  /** S6：error 池按组件计数（组件级独立走线可观测性；旧形态归档计入 kernel） */
  async errorCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const e of await this.listError()) {
      counts[e.component] = (counts[e.component] ?? 0) + 1;
    }
    return counts;
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

  /** 信任池计数快照（T8.21 contamination_risk 采集源；只读，消费方零副作用——读路径不建目录）。
   *  untrusted = untrusted 区记录；rejected = rejected 区记录（均非 trusted → 污染风险侧）。 */
  async counts(): Promise<{ trusted: number; untrusted: number; rejected: number }> {
    const all = await this.scanRecords(ZONES);
    let trusted = 0;
    let untrusted = 0;
    let rejected = 0;
    for (const r of all) {
      if (r.status === 'trusted') {
        trusted++;
      } else if (r.status === 'rejected') {
        rejected++;
      } else {
        untrusted++;
      }
    }
    return { trusted, untrusted, rejected };
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

  /** 移动记录（含 payload/provenance 清单）：写入目标区 record.json（经 transform）+ payload.txt + provenance.json，删除源区 */
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
    await this.copyAuxFile(srcDir, dstDir, PAYLOAD_FILE);
    await this.copyAuxFile(srcDir, dstDir, PROVENANCE_FILE);
    await rm(srcDir, { recursive: true, force: true });
  }

  /** 复制候选目录中的辅助文件（payload/provenance 清单；源缺失 → 跳过） */
  private async copyAuxFile(srcDir: string, dstDir: string, name: string): Promise<void> {
    try {
      const content = await readFile(join(srcDir, name), 'utf8');
      await writeFile(join(dstDir, name), content, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
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

  // ---- S6：error 区内部工具（组件归属解析 + 双形态归档检查） ----

  /**
   * S6：候选组件归属解析（最小实现——provenance.component 字段；注册组件 manifest id 匹配需
   * 注册表注入面，candidates 零依赖不 import component-registry——注释声明留后续）。读取候选
   * provenance.json（当前所在区，或旧形态 error/<id>/ 归档——S6 前无 component 字段 → null →
   * 调用方缺省 kernel）。缺失/损坏 → null（归属为附加元数据，不阻断归档）。
   */
  private async resolveProvenanceComponent(id: string): Promise<string | null> {
    const name = candidateDirName(id);
    const sources: string[] = [];
    const found = await this.findRecordWithZone(id);
    if (found !== null) {
      sources.push(join(this.evolutionRoot, found.zone, name));
    }
    sources.push(join(this.evolutionRoot, 'error', name)); // 旧形态归档（新形态组件已明确，无需解析）
    for (const dir of sources) {
      try {
        const prov = JSON.parse(await readFile(join(dir, PROVENANCE_FILE), 'utf8')) as { component?: unknown };
        if (typeof prov.component === 'string' && prov.component.length > 0) {
          return prov.component;
        }
      } catch {
        // 缺失/损坏 → 尝试下一来源
      }
    }
    return null;
  }

  /** S6：已归档检查（幂等键双形态——新形态 error/<component>/<id>/ 或旧形态 error/<id>/） */
  private async archivedInError(id: string, component: string): Promise<boolean> {
    const name = candidateDirName(id);
    if ((await this.readErrorRecord(join(this.evolutionRoot, 'error', component, name))) !== null) {
      return true;
    }
    return (await this.readErrorRecord(join(this.evolutionRoot, 'error', name))) !== null;
  }

  /** 读 error 归档 record.json（不存在 → null；损坏 fail-loud——同 scanRecords 语义） */
  private async readErrorRecord(dir: string): Promise<CandidateRecord | null> {
    try {
      return JSON.parse(await readFile(join(dir, RECORD_FILE), 'utf8')) as CandidateRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new Error(`candidates: error 归档损坏（${join(dir, RECORD_FILE)}）: ${(err as Error).message}`);
    }
  }

  /** 读 error 归档 reason.txt（缺失/不可读 → null——reason 为附注，不阻塞清单） */
  private async readReasonText(dir: string): Promise<string | null> {
    try {
      return await readFile(join(dir, 'reason.txt'), 'utf8');
    } catch {
      return null;
    }
  }
}
