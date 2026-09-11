// S4 Artifact Index（用户 2026-08-25 第二阶段裁决：事件驱动制品索引）：layer 1 存储与发现 I/O。
// 存储：JSONL 索引 <root>/index.jsonl（root 由构造参数注入——装配面注入 <root>/.evolution/artifacts）。
//   每条记录一行 JSON（Artifact Manifest）；写语义：全量原子写（读 → 改 → 写 .tmp → rename，
//   进程内读不见半截文件）；写失败 → degraded 记录不抛（尽力而为——索引缺失/不可写不阻塞主链）；
//   损坏行 → 跳过（审计日志语义：坏行留给运维，索引不得因此死亡）。
// 发现：discoverArtifactsFromEvents —— 只扫 type='tool/result' 事件，从 payload 文本/JSON 字符串
//   提取路径样 token（文件扩展名白名单正则）→ root 提供时解析到 root 下且文件存在 → 读内容 sha256 →
//   manifest（restorable:true）；不存在/越界 → 跳过（不索引幽灵路径）；root 未提供 → 仍索引
//   （hash='unavailable'、restorable=false——诚实缺省：索引「事件提及的路径」这一事实，不臆造可恢复性）。
//   查询：queryRecent（最近序）/ queryRelevant（专项 D：按任务目标相关性排序——关键词重叠 + 类型提示 +
//   最近性的廉价打分，无 embedding，轻量分词器内嵌不跨层 import）。
//   provenance/producing_event = 事件 id；environment = 传入指纹；created_at = now ?? Date.now()；
//   每事件最多 MAX_ARTIFACTS_PER_EVENT 个制品（防噪声）；抛错降级返回 []（尽力而为）。
// 层 DAG（CONVENTIONS §4）：layer 1（supervisor/）仅 import node: 内置 + kernel/schemas/
//   （IR 契约例外——manifest schema 纯契约，无运行时副作用；supervisor → kernel 其他路径仍禁止）。
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  ArtifactManifestSchema,
  artifactManifestId,
  inferArtifactType,
  type ArtifactManifest,
} from '../kernel/schemas/artifact.js';

// ---- 常量 ----

/** 索引上限（超限淘汰最旧——防无界增长；500 ≈ 会话制品量的量级上限，待标定 §17） */
export const ARTIFACT_CAP = 500;

/** 每事件最多提取的制品数（防噪声——一次工具结果提及大量路径时只索引前 5 个） */
export const MAX_ARTIFACTS_PER_EVENT = 5;

/** 装配面每次 finalizeTurn 传入的「最近会话事件」上限（discover 输入侧封顶） */
export const ARTIFACT_DISCOVERY_EVENT_LIMIT = 20;

/** 装配面取「最近事件」的拉取窗口（event-store 仅支持 seq ASC 分页——先取至多 N 条、
 *  再取窗口尾最近 20 条；会话事件数超窗口时只保证窗口内最近 N 条；待标定 §17） */
export const ARTIFACT_DISCOVERY_FETCH_LIMIT = 100;

/** 路径样 token 提取正则（文件扩展名白名单：ts/js/tsx/jsx/json/md/yaml/yml/py/txt/log；
 *  交替序最长优先——`js`/`ts` 是 `json`/`tsx` 的前缀，须放其后（"package.js" 会截断 "package.json"）） */
/**
 * 路径样 token（扩展名白名单）。
 * 已知问题《制品索引未建立》修复的一部分：原正则不含盘符前缀，且**未考虑 payload 是 JSON 文本**
 * （`JSON.stringify` 会把路径里的 `\` 变成 `\\`）——Windows 绝对路径因此被截成
 * `Users\...\report.md`（丢掉 `C:`），resolve 后落在仓库根之外 → 被 `isUnderRoot` 判越界 →
 * 真实工作文件全被过滤（"制品索引从未生成"的直接原因之一）。现允许：可选盘符前缀 +
 * 一或两个反斜杠作为分隔符（覆盖真实路径与 JSON 转义路径两种形态）。
 */
const ARTIFACT_PATH_TOKEN_RE = /(?:[A-Za-z]:)?[A-Za-z0-9_\-./\\~@]+\.(tsx|jsx|json|ts|js|yaml|yml|md|txt|py|log)/g;

/** token → 真实路径（JSON 转义的 `\\` 归一为单分隔符；盘符形态保持绝对路径） */
function normalizeTokenPath(token: string): string {
  return token.replace(/\\{2}/g, '\\');
}

// ---- 专项 D：产物按任务相关性排序（评审问题二——廉价近似，无 embedding、无新依赖） ----

/** 相关性排序候选池大小（最近 N 条内打分——超池截断防全量打分成本；待标定 §17） */
export const ARTIFACT_RELEVANCE_POOL = 50;

/** 关键词重叠权重（每命中一个 goal∩path+type token 记 1 分；待标定 §17） */
export const ARTIFACT_OVERLAP_WEIGHT = 1.0;

/** 类型提示加分（goal token 命中制品 type 词——如 goal 含 'md' 而制品是 doc/md；待标定 §17） */
export const ARTIFACT_TYPE_HINT_BONUS = 1.5;

/** 最近性权重（池内相对最近性 [0,1] 的权重——越新略高；弱于关键词重叠，作决胜项；待标定 §17） */
export const ARTIFACT_RECENCY_WEIGHT = 0.02;

/**
 * 轻量相关性分词（专项 D——layer 1 内嵌近似，**不 import memory/cjk-ngram**（层 DAG：supervisor(1) →
 * memory(2) 禁止；context-candidates 的 tokenizeForFts 是 runtime(2) 同层用例，本面不满足层条件））。
 * 近似语义（与 cjk-ngram 同构的廉价版）：CJK 段滑动 bigram（单字 CJK 段 → 单字）+ 非 CJK 段按
 * 非字母数字分隔取小写单词。仅用于相关性重叠打分，非检索索引（召回准确性非本面职责）。
 */
function relevanceTokens(text: string): string[] {
  const out: string[] = [];
  const cjkRe = /[\u4e00-\u9fff]+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = cjkRe.exec(text)) !== null) {
    for (const w of text.slice(last, m.index).toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length > 0) {
        out.push(w);
      }
    }
    const run = m[0];
    if (run.length === 1) {
      out.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        out.push(run.slice(i, i + 2));
      }
    }
    last = m.index + run.length;
  }
  for (const w of text.slice(last).toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length > 0) {
      out.push(w);
    }
  }
  return out;
}

// ---- 小工具 ----

/** 错误信息提取（确定性；非 Error → String） */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** payload → 检索文本（字符串原样；对象 JSON 序列化；空/不可序列化 → ''） */
function payloadText(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload === undefined || payload === null) {
    return '';
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return '';
  }
}

/** resolved 路径是否在 root 之下（含 root 自身；Windows 大小写不敏感比较） */
function isUnderRoot(resolved: string, root: string): boolean {
  const r = resolve(root);
  const prefix = r.endsWith('/') || r.endsWith('\\') ? r : r + (process.platform === 'win32' ? '\\' : '/');
  const a = resolved.toLowerCase();
  const b = prefix.toLowerCase();
  return a === r.toLowerCase() || a.startsWith(b);
}

// ---- Artifact Index（layer 1 JSONL；构造零 I/O——首写建目录；幂等） ----

/**
 * 制品索引（JSONL 全量原子写；register 同 id 覆写；超限淘汰最旧；损坏行跳过；写失败降级记录不抛）。
 * 只做「统一索引与引用」——不存制品内容（制品本来就在文件系统/Git/工具结果/DSH 事件里）。
 */
export class ArtifactIndex {
  private readonly file: string;
  private writeError: string | null = null;
  /** 最近一次读失败原因（无 → null）。与"文件不存在"区分：非 null 时**禁止**读-改-写覆盖 */
  private lastReadError: string | null = null;

  constructor(opts: { root: string }) {
    // root = 制品索引根目录（.evolution/artifacts）——index.jsonl 与其同目录
    this.file = join(opts.root, 'index.jsonl');
  }

  /** 最近一次写降级原因（无 → null；写失败降级记录不抛——审计面） */
  get degraded(): string | null {
    return this.writeError;
  }

  /**
   * 全量读取：文件不存在 → []；损坏行跳过（审计日志语义——索引不因坏行死亡）。
   * **可读性标记**：读取异常（权限/IO）与"文件不存在"必须区分——前者把 `lastReadError` 置位，
   * 写侧（register）据此**拒绝全量覆盖**，否则一次瞬时 EBUSY/EPERM 会把磁盘既有索引整体截断
   * （读-改-写循环 + 全量原子写 = 数据丢失）。返回 [] 仅表示"本次没读到内容"，不表示"磁盘上没有内容"。
   */
  private async readAll(): Promise<ArtifactManifest[]> {
    this.lastReadError = null;
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []; // 文件不存在 → 空（首写建目录）
      }
      this.lastReadError = errorText(err); // 不可读（≠ 空）：写侧必须放弃覆盖
      return [];
    }
    const out: ArtifactManifest[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const ok = ArtifactManifestSchema.safeParse(parsed);
        if (ok.success) {
          out.push(ok.data);
        }
        // 损坏/形状不合规行 → 跳过（审计日志语义：坏行留给运维，索引继续）
      } catch {
        // JSON 语法损坏行 → 跳过（同上）
      }
    }
    return out;
  }

  /** 全量原子写（tmp+rename）：建目录 → 写 .tmp → rename；失败 → degraded 记录返回 false（不抛） */
  private async writeAll(manifests: ArtifactManifest[]): Promise<boolean> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      // 唯一临时名（审查 M4）：固定 `.tmp` 在 register/registerMany 并发时会命中同一路径互相截断，
      // 而读侧对坏行是"跳过"语义 → 索引内容静默丢失。同仓 lines.ts/activation-log.ts 已是 pid+随机后缀写法。
      const tmp = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(tmp, manifests.map((m) => JSON.stringify(m)).join('\n') + (manifests.length > 0 ? '\n' : ''), 'utf8');
      await rename(tmp, this.file);
      this.writeError = null;
      return true;
    } catch (err) {
      this.writeError = `制品索引写入失败（尽力而为降级，不阻塞主链）：${errorText(err)}`;
      return false;
    }
  }

  /** 上限淘汰（超限 → 淘汰最旧——按 created_at 升序，同毫秒按 id 稳定排序；确定性） */
  private enforceCap(manifests: ArtifactManifest[]): ArtifactManifest[] {
    if (manifests.length <= ARTIFACT_CAP) {
      return manifests;
    }
    const sorted = [...manifests].sort(
      (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return sorted.slice(sorted.length - ARTIFACT_CAP);
  }

  /**
   * 注册/覆写（同 id 覆写——最新 manifest 胜出；schema 非法 → fail-loud）。
   * 索引超限 → 淘汰最旧（ARTIFACT_CAP=500）；写失败 → degraded 记录不抛。
   */
  async register(manifest: ArtifactManifest): Promise<void> {
    const parsed = ArtifactManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      throw new Error(`ArtifactIndex.register: manifest schema 校验失败 — ${parsed.error.message}`);
    }
    const m = parsed.data;
    const records = await this.readAll();
    if (this.lastReadError !== null) {
      // 读失败 ≠ 空：此刻全量写会把磁盘既有索引整体截断（读-改-写 + 原子覆盖 = 数据丢失）。
      // 诚实降级：本次写入放弃并留痕（索引短暂落后 = 可恢复；索引被截断 = 不可恢复）。
      this.writeError = `制品索引读取失败，已跳过本次写入以免覆盖既有索引：${this.lastReadError}`;
      return;
    }
    const without = records.filter((r) => r.id !== m.id);
    without.push(m);
    await this.writeAll(this.enforceCap(without));
  }

  /**
   * 批量注册（同一批一次读 + 一次写）：单轮发现可达 100 个 manifest，逐条 register 是
   * N 次全量读 + N 次全量原子写（O(n²) 解析与重写，每轮固定开销）。
   * 语义与逐条 register 等价（同 id 覆写、批内后者胜出、超限淘汰最旧、schema 非法 fail-loud、
   * 读失败拒写）；空数组 → 无 I/O。
   */
  async registerMany(manifests: readonly ArtifactManifest[]): Promise<void> {
    if (manifests.length === 0) {
      return;
    }
    const parsed: ArtifactManifest[] = [];
    for (const manifest of manifests) {
      const ok = ArtifactManifestSchema.safeParse(manifest);
      if (!ok.success) {
        throw new Error(`ArtifactIndex.registerMany: manifest schema 校验失败 — ${ok.error.message}`);
      }
      parsed.push(ok.data);
    }
    const records = await this.readAll();
    if (this.lastReadError !== null) {
      this.writeError = `制品索引读取失败，已跳过本次批量写入以免覆盖既有索引：${this.lastReadError}`;
      return;
    }
    // 批内同 id 去重（后者胜出——与逐条 register 的顺序语义等价）：只留每个 id 的最后一条
    const batch = new Map<string, ArtifactManifest>();
    for (const m of parsed) {
      batch.set(m.id, m);
    }
    const merged = records.filter((r) => !batch.has(r.id));
    merged.push(...batch.values());
    await this.writeAll(this.enforceCap(merged));
  }

  /** 最近制品（created_at 降序——最新优先；同毫秒按 id 稳定排序；limit 截断；缺省全量） */
  async queryRecent(limit?: number): Promise<ArtifactManifest[]> {
    const records = await this.readAll();
    const sorted = records.sort(
      (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return limit === undefined ? sorted : sorted.slice(0, limit);
  }

  /**
   * 按任务目标相关性排序（专项 D——评审问题二）：候选池 = 最近 ARTIFACT_RELEVANCE_POOL 条
   * （created_at 降序截断；超池的最旧产物不参与打分——防全量打分成本）。廉价相关性打分（无 embedding）：
   *   score = ARTIFACT_OVERLAP_WEIGHT × |goalTokens ∩ (path+type)Tokens|   关键词重叠
   *         + ARTIFACT_TYPE_HINT_BONUS × (type 词 ∈ goalTokens ? 1 : 0)     类型提示
   *         + ARTIFACT_RECENCY_WEIGHT × (created_at − 池最小) / max(1, 池跨度)  最近性（池内相对，越新略高）
   * 返回 score 降序 top limit；同分 → created_at 降序、id 升序（确定性，与 queryRecent 同款决胜）。
   * goal 为空 → 关键词/类型项恒 0 → 纯最近性序（等价 queryRecent(pool) 语义）。确定性：同索引同 goal
   * → 恒同序（打分纯函数，无时间/随机依赖——池内相对最近性）。
   */
  async queryRelevant(goal: string, limit: number): Promise<ArtifactManifest[]> {
    const records = await this.readAll();
    const recent = records
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, ARTIFACT_RELEVANCE_POOL);
    const goalTokens = new Set(relevanceTokens(goal));
    const minCreated = recent.length > 0 ? Math.min(...recent.map((m) => m.created_at)) : 0;
    const span = recent.length > 0 ? Math.max(...recent.map((m) => m.created_at)) - minCreated : 0;
    const scored = recent.map((m) => {
      const artTokens = new Set(relevanceTokens(`${m.path} ${m.type}`));
      let overlap = 0;
      for (const t of artTokens) {
        if (goalTokens.has(t)) {
          overlap++;
        }
      }
      const typeHit = goalTokens.has(m.type.toLowerCase()) ? 1 : 0;
      const recency = span > 0 ? (m.created_at - minCreated) / span : 0;
      return {
        m,
        score:
          ARTIFACT_OVERLAP_WEIGHT * overlap +
          ARTIFACT_TYPE_HINT_BONUS * typeHit +
          ARTIFACT_RECENCY_WEIGHT * recency,
      };
    });
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.m.created_at - a.m.created_at ||
        (a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0),
    );
    return scored.slice(0, limit).map((s) => s.m);
  }

  /** 全量清单（文件序；排序不保证——查询请用 queryRecent） */
  async list(): Promise<ArtifactManifest[]> {
    return this.readAll();
  }

  /** 索引条目数 */
  async count(): Promise<number> {
    return (await this.readAll()).length;
  }
}

// ---- 事件驱动发现（尽力而为；抛错降级返回 []） ----

/** discoverArtifactsFromEvents 选项 */
export interface ArtifactDiscoveryOptions {
  /** 解析根（提供时：路径解析到 root 下且文件存在 → 读内容 sha256、restorable:true；
   *  不存在 → 跳过；未提供 → 仍索引 hash='unavailable'/restorable:false 诚实缺省） */
  root?: string;
  /**
   * 解析根**集合**（已知问题《制品索引未建立》修复：发现根改为会话工作目录或可配置根集合）。
   * 提供时优先于 `root`：逐根尝试解析，任一命中即读内容；**全部未命中 → 记为不可恢复制品
   *（restorable:false，path 原样保留）而不是直接丢弃**——只索引实际存在的文件会漏掉"在别的项目
   * 目录里、本次会话确实产出过"的制品（原实现以仓库根为根，用户真实工作文件全被过滤）。
   */
  roots?: readonly string[];
  /** 环境指纹（Record<string,string>——Fingerprint 过滤非字符串键后的落盘面；写入每个 manifest.environment） */
  environment: Record<string, string>;
  /** 时间戳（epoch ms；缺省 Date.now） */
  now?: number;
}

/**
 * 事件驱动制品发现（S4）：只扫 type='tool/result' 事件，从 payload 文本/JSON 字符串提取路径样 token
 * （扩展名白名单正则；去重；每事件最多 MAX_ARTIFACTS_PER_EVENT 个）→ 逐 token 构造 Artifact Manifest
 * （type=inferArtifactType；id=sha256(path|provenance) 前缀 16；provenance/producing_event=事件 id；
 * environment=传入指纹；created_at=now）。root 提供 → 只索引 root 下存在的文件（hash 真实、restorable:true），
 * 幽灵路径/越界跳过；root 未提供 → 仍索引（hash='unavailable'、restorable:false——诚实缺省）。
 * 尽力而为：任何抛错 → 返回 []（不向调用方传播——制品索引缺失不阻塞事件主链）。
 */
export async function discoverArtifactsFromEvents(
  events: ReadonlyArray<{ id: string; type?: string; payload?: unknown }>,
  opts: ArtifactDiscoveryOptions,
): Promise<ArtifactManifest[]> {
  try {
    const out: ArtifactManifest[] = [];
    const now = opts.now ?? Date.now();
    for (const ev of events) {
      if (ev.type !== 'tool/result') {
        continue; // 只扫 tool/result（工具结果才可能产生文件系统/Git 制品）
      }
      const text = payloadText(ev.payload);
      if (text.length === 0) {
        continue;
      }
      const tokens = [...new Set(text.match(ARTIFACT_PATH_TOKEN_RE) ?? [])].slice(0, MAX_ARTIFACTS_PER_EVENT);
      for (const token of tokens) {
        const manifest = await buildDiscoveredManifest(token, ev.id, opts, now);
        if (manifest !== null) {
          out.push(manifest);
        }
      }
    }
    return out;
  } catch {
    return []; // 尽力而为：抛错降级返回 []（不阻塞调用方）
  }
}

/** 单 token → manifest；根集合逐根尝试；全部未命中 → 不可恢复制品（不再直接丢弃） */
async function buildDiscoveredManifest(
  token: string,
  eventId: string,
  opts: ArtifactDiscoveryOptions,
  now: number,
): Promise<ArtifactManifest | null> {
  // token 来自 JSON 文本（`JSON.stringify` 会把 `\` 变 `\\`）→ 归一为真实路径形态
  const pathToken = normalizeTokenPath(token);
  const base = {
    id: artifactManifestId(pathToken, eventId),
    type: inferArtifactType(pathToken),
    path: pathToken,
    provenance: eventId,
    producing_event: eventId,
    environment: opts.environment,
    created_at: now,
  };
  const roots = opts.roots !== undefined && opts.roots.length > 0 ? opts.roots : opts.root === undefined ? [] : [opts.root];
  if (roots.length === 0) {
    // root 未提供 → 仍索引：hash='unavailable'/restorable=false——诚实缺省（不读文件不臆造可恢复性；
    // 索引「事件提及的路径」这一事实本身，可恢复性留待 root 提供的装配面判定）
    return { ...base, hash: 'unavailable', restorable: false };
  }
  // 逐根尝试：任一根下存在且可读 → 真实 hash + restorable:true
  for (const root of roots) {
    const resolved = resolve(root, pathToken);
    if (!isUnderRoot(resolved, root)) {
      continue; // 该根下越界（绝对路径/.. 逃逸）→ 试下一个根
    }
    try {
      const content = await readFile(resolved);
      return {
        ...base,
        hash: createHash('sha256').update(content).digest('hex'),
        restorable: true,
      };
    } catch {
      // 该根下不存在/不可读 → 试下一个根
    }
  }
  // 全部根未命中 → **记为不可恢复制品**（已知问题《制品索引未建立》修复：根外路径不直接丢弃）。
  // 语义：索引保留"本次会话确实提及过该路径"这一事实；restorable:false 诚实标注当前不可恢复。
  return { ...base, hash: 'unavailable', restorable: false };
}
