// layer 2（runtime/）：演化信号落盘/读取（架构 §6.5.1 触发链：事件源 → .evolution/signals/ JSONL）。
// - appendSignals：信号写入 .evolution/signals/<yyyy-mm-dd>.jsonl（追加；幂等建目录；每行一个信号对象
//   {ts, kind, session_id?, payload}——SignalRecordSchema 校验 fail-loud 防坏数据出站）；
//   按日分组追加（跨午夜不混文件）。
// - readSignals：读取当日（或指定日）信号记录；损坏行跳过并计数（日志为尽力而为，不因坏行崩判定）。
// 依赖：kernel/schemas/evolution.js（契约层，SignalRecordSchema）+ node: 内置（层 DAG：runtime(2) → kernel(2) ✓）。
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SignalRecordSchema, type SignalRecord } from '../kernel/schemas/evolution.js';

/** 信号落盘目录（<root>/.evolution/signals；root = 认知数据根 workspace/.omb） */
export function signalsDirOf(root: string): string {
  return join(root, '.evolution', 'signals');
}

/** 信号文件名（<yyyy-mm-dd>.jsonl；UTC 日期——跨时区一致） */
export function signalFileName(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 10)}.jsonl`;
}

/**
 * 追加写入信号（幂等建目录；JSONL 每行一个信号对象；按日分文件追加）。
 * 返回 { files: string[]; appended: number }（实际写入的文件路径 + 追加行数）。
 */
export async function appendSignals(
  dir: string,
  records: readonly SignalRecord[],
): Promise<{ files: string[]; appended: number }> {
  if (records.length === 0) {
    return { files: [], appended: 0 };
  }
  await mkdir(dir, { recursive: true });
  const byDay = new Map<string, SignalRecord[]>();
  for (const r of records) {
    const day = signalFileName(r.ts);
    const list = byDay.get(day) ?? [];
    list.push(r);
    byDay.set(day, list);
  }
  const files: string[] = [];
  let appended = 0;
  for (const [day, recs] of byDay) {
    const file = join(dir, day);
    const lines = recs
      .map((r) => JSON.stringify(SignalRecordSchema.parse(r)))
      .join('\n');
    await appendFile(file, lines.length > 0 ? `${lines}\n` : '', 'utf8');
    files.push(file);
    appended += recs.length;
  }
  return { files, appended };
}

/**
 * 读取信号记录（缺省当日文件；损坏行跳过并计数——信号为日志性质，不因坏行崩判定）。
 * 目录/文件不存在 → { records: [], skipped: 0 }（判定按空摘要走，安全降级）。
 */
export async function readSignals(
  dir: string,
  opts: { day?: string } = {},
): Promise<{ records: SignalRecord[]; skipped: number }> {
  const file = join(dir, opts.day ?? signalFileName(Date.now()));
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], skipped: 0 };
    }
    throw err;
  }
  const records: SignalRecord[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = SignalRecordSchema.safeParse(JSON.parse(trimmed) as unknown);
      if (parsed.success) {
        records.push(parsed.data);
      } else {
        skipped++;
      }
    } catch {
      skipped++; // JSON 语法损坏行
    }
  }
  return { records, skipped };
}
