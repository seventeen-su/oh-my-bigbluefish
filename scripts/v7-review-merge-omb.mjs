#!/usr/bin/env node
/**
 * 合并 v7.x 分段审查报告里的 OMB JSONL 到 docs/v7/review/omb/{memories,states,chains}.jsonl。
 *
 * 用户要求这一轮用文档记录记忆/状态机/思维链，不写 PostgreSQL。脚本只做：
 * - 从 docs/v7/review/audit/*.md（以及可选的 docs/v7/review/RESEARCH.md）提取 ```jsonl 代码块；
 * - 解析、去重、校验 kind/category/status/chain.group 引用；
 * - 与 docs/v7/review/omb/ 已有账本合并，按 id 稳定排序写出。
 *
 * 用法：
 *   node scripts/v7-review-merge-omb.mjs            # 合并并写文件
 *   node scripts/v7-review-merge-omb.mjs --check    # 只校验，不写
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const REPORT_DIR = join(ROOT, "docs", "v7", "review", "audit");
const LEDGER_DIR = join(ROOT, "docs", "v7", "review", "omb");
const CHECK = process.argv.includes("--check");
const KINDS = new Set(["memory", "state", "chain"]);
const CATEGORIES = new Set(["fact", "clue", "event"]);
const STATUSES = new Set([
  "completed",
  "in_progress",
  "waiting",
  "blocked",
  "not_started",
  "discarded",
]);

function fail(message) {
  throw new Error(message);
}

function sourceFiles() {
  if (!existsSync(REPORT_DIR)) fail(`缺少报告目录：${REPORT_DIR}`);
  const names = readdirSync(REPORT_DIR)
    .filter(
      (name) =>
        /^\d{2}-.*\.md$/.test(name) || name === "09-requirements-trace.md",
    )
    .sort();
  const research = join(ROOT, "docs", "v7", "review", "RESEARCH.md");
  return [
    ...names.map((name) => join(REPORT_DIR, name)),
    ...(existsSync(research) ? [research] : []),
  ];
}

function extractJsonl(text, file) {
  const blocks = [...text.matchAll(/```jsonl\s*\n([\s\S]*?)```/g)];
  const lines =
    blocks.length > 0
      ? blocks.flatMap((block) => block[1].split(/\r?\n/))
      : text
          .split(/\r?\n/)
          .filter((line) => line.trimStart().startsWith('{"id"'));
  const out = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith("{")) continue;
    try {
      out.push({ record: JSON.parse(trimmed), file, line: index + 1 });
    } catch (error) {
      fail(`${file} 第 ${index + 1} 行 JSONL 解析失败：${error.message}`);
    }
  }
  return out;
}

function validate(record, file) {
  if (typeof record.id !== "string" || record.id.length === 0)
    fail(`${file}: 记录缺少 id`);
  if (!KINDS.has(record.kind))
    fail(`${file}: ${record.id} kind 非法：${record.kind}`);
  if (record.kind === "memory") {
    if (!CATEGORIES.has(record.category))
      fail(`${file}: ${record.id} category 非法`);
    if (record.scope === undefined) fail(`${file}: ${record.id} 缺少 scope`);
    if (
      record.attrs === undefined ||
      typeof record.attrs !== "object" ||
      Array.isArray(record.attrs)
    ) {
      fail(`${file}: ${record.id} attrs 必须是对象`);
    }
  }
  if (record.kind === "state") {
    if (typeof record.title !== "string" || record.title.trim().length === 0)
      fail(`${file}: ${record.id} 缺少 title`);
    if (!STATUSES.has(record.status)) fail(`${file}: ${record.id} status 非法`);
    if (typeof record.time !== "string")
      fail(`${file}: ${record.id} 缺少 time`);
  }
  if (record.kind === "chain") {
    if (!Array.isArray(record.group) || record.group.length === 0)
      fail(`${file}: ${record.id} group 必须是非空数组`);
    for (const member of record.group)
      if (typeof member !== "string")
        fail(`${file}: ${record.id} group 含非字符串`);
  }
}

function readLedger(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const [index, line] of readFileSync(file, "utf8")
    .split(/\r?\n/)
    .entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (error) {
      fail(`${file} 第 ${index + 1} 行解析失败：${error.message}`);
    }
  }
  return out;
}

const byId = new Map();
for (const name of ["memories", "states", "chains"]) {
  for (const record of readLedger(join(LEDGER_DIR, `${name}.jsonl`))) {
    if (byId.has(record.id)) fail(`账本内重复 id：${record.id}`);
    validate(record, `${name}.jsonl`);
    byId.set(record.id, record);
  }
}

for (const file of sourceFiles()) {
  const text = readFileSync(file, "utf8");
  for (const { record } of extractJsonl(text, file)) {
    validate(record, file);
    if (byId.has(record.id)) continue;
    byId.set(record.id, record);
  }
}

const all = [...byId.values()].sort((left, right) =>
  left.id.localeCompare(right.id),
);
const ids = new Set(all.map((record) => record.id));
for (const record of all) {
  if (record.kind !== "chain") continue;
  for (const member of record.group) {
    if (!ids.has(member))
      fail(`chain ${record.id} 引用不存在的成员：${member}`);
  }
}
for (const record of all) {
  for (const link of record.links ?? []) {
    if (typeof link?.to === "string" && !ids.has(link.to))
      fail(`${record.id} link 指向不存在的 id：${link.to}`);
  }
}

const memories = all.filter((record) => record.kind === "memory");
const states = all.filter((record) => record.kind === "state");
const chains = all.filter((record) => record.kind === "chain");

function writeJsonl(file, records) {
  writeFileSync(
    file,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8",
  );
}

if (!CHECK) {
  writeJsonl(join(LEDGER_DIR, "memories.jsonl"), memories);
  writeJsonl(join(LEDGER_DIR, "states.jsonl"), states);
  writeJsonl(join(LEDGER_DIR, "chains.jsonl"), chains);
}

const bySegment = new Map();
for (const record of all) {
  const segment = record.attrs?.segment ?? record.attrs?.scope ?? "unknown";
  bySegment.set(segment, (bySegment.get(segment) ?? 0) + 1);
}
console.log(
  `[omb] ${CHECK ? "CHECK" : "MERGED"} memories=${memories.length} states=${states.length} chains=${chains.length} total=${all.length}`,
);
console.log(
  `[omb] segments=${[...bySegment.entries()]
    .sort()
    .map(([key, value]) => `${key}:${value}`)
    .join(", ")}`,
);
if (CHECK) console.log("[omb] PASS");
