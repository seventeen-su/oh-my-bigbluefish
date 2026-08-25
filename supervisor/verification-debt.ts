// layer 1（supervisor/）：验证债务队列（S2——用户 2026-08-25 第二阶段裁决）。
// 语义（裁决 S2）：Judge 不确定/不可用 → 入验证债务队列 → 维护期（/bench、/evolve、维护量子）统一
//   处理——不污染普通请求。阶梯式验证：UNKNOWN 是合法终态，债务保留待复核，不强迫 LLM 猜。
// 存储：JSONL 队列 <verificationRoot>/debt.jsonl（根由构造参数注入；缺省装配面注入
//   <root>/.evolution/verification/——与验证数据面三库同根系）。每条记录一行 JSON。
// 写语义：全量原子写（读 → 改 → 写 <file>.tmp → rename <file>——进程内读不见半截文件）；
//   写失败 → degraded 记录不抛（尽力而为——队列缺失/不可写不阻塞验证主链）；损坏行 → 跳过
//   （审计日志语义：坏行是数据问题留给运维，但队列不得因此死亡）。
// 层 DAG：layer 1（supervisor/）仅 import node: 内置（不 import kernel 逻辑——IR 契约例外亦不需要）。
// 消费方 = runtime/assembly.ts（入队/复核）与 tests（豁免）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ---- 记录类型 ----

/** 复核决议（markResolved 落盘；verdict/judge_used/ts + detail 审计字段） */
export interface VerificationDebtResolution {
  /** 复核判定（PASS/FAIL——单次结构化裁判产出；无 → 未决） */
  verdict?: 'PASS' | 'FAIL' | 'UNKNOWN';
  /** 是否经 judge 判定（true=空白子代理裁判；false/缺省=人工/降级标记） */
  judge_used?: boolean;
  /** 决议时间戳（epoch ms） */
  ts?: number;
  /** 审计细节（如「judge 不可用——空白子代理未装配」） */
  detail?: string;
}

/** 验证债务记录（shadow/repair 未决验证的统一队列条目） */
export interface VerificationDebtRecord {
  /** 去重键（shadow:<sessionId> / repair:<objectId>——同键覆写去重） */
  key: string;
  /** 债务来源类型：shadow=shadow 会话 outcome UNKNOWN；repair=repair 对象 verdict UNKNOWN */
  kind: 'shadow' | 'repair';
  /** 关联验证契约 id（shadow:<sessionId> / repair:<objectId>） */
  contract_id: string;
  /** 受影响对象引用（repair 债务；shadow 债务无） */
  object_ref?: string;
  /** 复核材料（goal/success_criteria/degraded/decision_made 或 kind/verdict/evidence_quality/disposition） */
  materials: unknown;
  /** 入队时间戳（epoch ms） */
  created_at: number;
  /** 复核尝试次数（UNKNOWN 未决递增；>=2 → pending_manual 低频人工复核） */
  attempts: number;
  /** 队列状态：pending=待复核 / resolved=已决议 / pending_manual=转人工复核 */
  status: 'pending' | 'resolved' | 'pending_manual';
  /** 决议（resolved/pending_manual 时提供） */
  resolution?: VerificationDebtResolution;
  /** 最近一次复核尝试时间戳（bumpAttempts 写） */
  last_attempt_at?: number;
}

/** 入队输入（created_at/attempts/status 由队列内部填充） */
export type VerificationDebtInput = Pick<
  VerificationDebtRecord,
  'key' | 'kind' | 'contract_id' | 'materials'
> &
  Partial<Pick<VerificationDebtRecord, 'object_ref'>>;

/** 队列上限（超限淘汰最旧——防无界增长；500 条 ≈ 复核批量的量级上限） */
export const DEBT_CAP = 500;

// ---- 小工具 ----

/** 错误信息提取（确定性；非 Error → String） */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 记录最小形状校验（损坏行跳过——审计日志语义；只要求关键字段类型） */
function isDebtRecord(value: unknown): value is VerificationDebtRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.key === 'string' &&
    rec.key.length > 0 &&
    (rec.kind === 'shadow' || rec.kind === 'repair') &&
    typeof rec.contract_id === 'string' &&
    (rec.status === 'pending' || rec.status === 'resolved' || rec.status === 'pending_manual')
  );
}

/**
 * 验证债务队列（layer 1 JSONL；构造零 I/O——首写建目录；幂等）。
 * 全部写操作全量原子重写（tmp+rename）；写失败 → degraded 记录不抛（尽力而为）。
 */
export class VerificationDebt {
  private readonly file: string;
  private writeError: string | null = null;

  constructor(opts: { root: string }) {
    // root = 验证数据面根目录（.evolution/verification）——debt.jsonl 与其同目录
    this.file = join(opts.root, 'debt.jsonl');
  }

  /** 最近一次写降级原因（无 → null；写失败降级记录不抛——审计面） */
  get degraded(): string | null {
    return this.writeError;
  }

  /** 全量读取：文件不存在 → []；损坏行跳过（审计日志语义——队列不因坏行死亡） */
  private async readAll(): Promise<VerificationDebtRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []; // 文件不存在 → 空（首写建目录）
      }
      return []; // 读取异常（权限/IO）→ 视作空（不抛；写侧会重建）——诚实降级
    }
    const out: VerificationDebtRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isDebtRecord(parsed)) {
          out.push(parsed);
        }
        // 损坏/形状不合规行 → 跳过（审计日志语义：坏行留给运维，队列继续）
      } catch {
        // JSON 语法损坏行 → 跳过（同上）
      }
    }
    return out;
  }

  /** 全量原子写（tmp+rename）：建目录 → 写 .tmp → rename；失败 → degraded 记录返回 false（不抛） */
  private async writeAll(records: VerificationDebtRecord[]): Promise<boolean> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''), 'utf8');
      await rename(tmp, this.file);
      this.writeError = null;
      return true;
    } catch (err) {
      this.writeError = `验证债务写入失败（尽力而为降级，不阻塞验证主链）：${errorText(err)}`;
      return false;
    }
  }

  /** 队列上限淘汰（超限 → 淘汰最旧——按 created_at 升序，同毫秒按 key 稳定排序） */
  private enforceCap(records: VerificationDebtRecord[]): VerificationDebtRecord[] {
    if (records.length <= DEBT_CAP) {
      return records;
    }
    const sorted = [...records].sort(
      (a, b) => a.created_at - b.created_at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    return sorted.slice(sorted.length - DEBT_CAP);
  }

  /**
   * 入队/覆写（同 key 去重覆写——最新观测胜出；全新记录 attempts=0/status='pending'）。
   * 队列超限 → 淘汰最旧（DEBT_CAP=500）；写失败 → degraded 记录不抛。
   */
  async enqueue(input: VerificationDebtInput): Promise<void> {
    const records = await this.readAll();
    const without = records.filter((r) => r.key !== input.key);
    without.push({
      key: input.key,
      kind: input.kind,
      contract_id: input.contract_id,
      ...(input.object_ref !== undefined ? { object_ref: input.object_ref } : {}),
      materials: input.materials,
      created_at: Date.now(),
      attempts: 0,
      status: 'pending',
    });
    await this.writeAll(this.enforceCap(without));
  }

  /** 待复核清单（status='pending'；按 created_at 升序——最老优先复核；limit 截断） */
  async listPending(limit?: number): Promise<VerificationDebtRecord[]> {
    const records = await this.readAll();
    const pending = records
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.created_at - b.created_at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return limit === undefined ? pending : pending.slice(0, limit);
  }

  /** 标记已决议（resolution 覆写——调用方传全量 {verdict, judge_used, ts}；记录不存在 → 不动作） */
  async markResolved(key: string, resolution: VerificationDebtResolution): Promise<boolean> {
    const records = await this.readAll();
    const target = records.find((r) => r.key === key);
    if (target === undefined) {
      return false;
    }
    target.status = 'resolved';
    target.resolution = resolution;
    return this.writeAll(records);
  }

  /** 转人工复核（仅 pending → pending_manual；resolution 记 detail/ts——低频人工复核标记；非 pending 不动作） */
  async markPendingManual(key: string, detail?: string): Promise<boolean> {
    const records = await this.readAll();
    const target = records.find((r) => r.key === key);
    if (target === undefined || target.status !== 'pending') {
      return false;
    }
    target.status = 'pending_manual';
    target.resolution = { ...(target.resolution ?? {}), detail, ts: Date.now() };
    return this.writeAll(records);
  }

  /** 复核尝试 +1（仅 pending；last_attempt_at 更新；返回新 attempts——调用方按 >=2 转人工；不存在/非 pending → null） */
  async bumpAttempts(key: string): Promise<number | null> {
    const records = await this.readAll();
    const target = records.find((r) => r.key === key);
    if (target === undefined || target.status !== 'pending') {
      return null;
    }
    target.attempts += 1;
    target.last_attempt_at = Date.now();
    await this.writeAll(records);
    return target.attempts;
  }
}
