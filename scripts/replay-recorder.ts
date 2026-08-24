// OMB v2 Replay fixture 录制工具——CLI 薄壳（developer tooling；架构 §14.6 开放项
// 「Replay Fixture 录制工具」/ §5.2 replay_fixture {event_id → canned_result}；清扫计划 S4）。
// 用法：pnpm replay-recorder --events <events.db|events.jsonl> --out <输出目录> [--name <fixture名>] [--source <描述>]
// 输入源（两源均支持，按 --events 后缀自动选择）：
//   - 以 .jsonl 结尾 → 事件 JSONL（每行一个 M3 Event JSON；非法行 fail-loud——录制不得静默丢事件）；
//   - 否则 → EventStore SQLite 事件库（node:sqlite，与 memory/backend 同技术；seq 游标分页读全量）。
// 产出：<out>/<name>.replay-fixture.json（ReplayFixtureFileSchema；canned 与 supervisor/replay.ts
//   字节级对齐——可直接组装进 ReplayFixture.canned 供 ReplayRunner 消费）。
// 退出码：0 = 成功；1 = 参数/输入/写入错误。
// 主逻辑在 main()，仅直接运行时调用（import 无副作用）；核心纯逻辑在 scripts/replay-recorder-core.ts
// （本文件仅 CLI 编排 + 公共 API 再导出，符合 LOC 预算拆分）。
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventSchema, type Event } from '../kernel/schemas/m.js';
import { EventStore } from '../supervisor/event-store.js';
import {
  DEFAULT_NAME,
  RECORDER_VERSION,
  recordFixtures,
  replayFixtureFileName,
  serializeReplayFixtureFile,
} from './replay-recorder-core.js';

export * from './replay-recorder-core.js';

const USAGE = `用法：pnpm replay-recorder --events <events.db|events.jsonl> --out <输出目录> [--name <fixture名>] [--source <来源描述>]
   --events：事件源——以 .jsonl 结尾按事件 JSONL（每行一个 M3 Event JSON）；否则按 EventStore SQLite 事件库读取
   --out：产物目录（自动创建）；写出 <name>.replay-fixture.json
   退出码：0 = 成功；1 = 参数/输入/写入错误`;

/** 单次事件库分页读取行数 */
const DB_PAGE = 1000;

/** 事件 JSONL → Event[]（每行 JSON.parse + M3 schema 校验；非法 fail-loud） */
export async function loadEventsFromJsonl(filePath: string): Promise<Event[]> {
  const raw = await readFile(filePath, 'utf8');
  const events: Event[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`replay-recorder: 事件 JSONL 第 ${i + 1} 行非法 JSON`);
    }
    const v = EventSchema.safeParse(parsed);
    if (!v.success) {
      const detail = v.error.issues
        .map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`)
        .join('; ');
      throw new Error(`replay-recorder: 事件 JSONL 第 ${i + 1} 行 M3 schema 校验失败——${detail}`);
    }
    events.push(v.data);
  }
  return events;
}

/** EventStore SQLite 事件库 → Event[]（seq 游标分页读全量；与 EventStore 同技术，零新依赖） */
export async function loadEventsFromDb(dbPath: string): Promise<Event[]> {
  if (!existsSync(dbPath)) {
    throw new Error(`replay-recorder: 事件库不存在: ${dbPath}`);
  }
  const store = new EventStore(dbPath);
  try {
    const events: Event[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page = await store.query({ limit: DB_PAGE, cursor });
      events.push(...page.events);
      if (page.next_cursor === undefined) {
        break;
      }
      cursor = page.next_cursor;
    }
    return events;
  } finally {
    await store.close();
  }
}

/** CLI 主逻辑（仅直接运行时执行；返回退出码，调用方设置 process.exitCode） */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let eventsPath: string | undefined;
  let outDir: string | undefined;
  let name = DEFAULT_NAME;
  let source: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--events' && argv[i + 1] !== undefined) {
      eventsPath = argv[i + 1]!;
      i++;
    } else if (a === '--out' && argv[i + 1] !== undefined) {
      outDir = argv[i + 1]!;
      i++;
    } else if (a === '--name' && argv[i + 1] !== undefined) {
      name = argv[i + 1]!;
      i++;
    } else if (a === '--source' && argv[i + 1] !== undefined) {
      source = argv[i + 1]!;
      i++;
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    } else {
      throw new Error(`replay-recorder: 未知参数 ${a}\n${USAGE}`);
    }
  }
  if (eventsPath === undefined || outDir === undefined) {
    throw new Error(`replay-recorder: 缺少必填参数（--events / --out）\n${USAGE}`);
  }
  const events = eventsPath.toLowerCase().endsWith('.jsonl')
    ? await loadEventsFromJsonl(eventsPath)
    : await loadEventsFromDb(eventsPath);
  const file = recordFixtures(events, {
    name,
    version: RECORDER_VERSION,
    source: source ?? `events:${eventsPath}`,
    ts: new Date().toISOString(),
  });
  const outFile = join(outDir, replayFixtureFileName(file.generated.name));
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, serializeReplayFixtureFile(file), 'utf8');
  console.log(
    `replay-recorder: ${file.generated.name} — ${Object.keys(file.fixture).length} canned / ` +
      `${file.non_replayable.length} non-replayable（${events.length} events）→ ${outFile}`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
