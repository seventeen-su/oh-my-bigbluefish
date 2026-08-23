// OMB v2 月度复盘报告工具——CLI 入口（developer tooling；架构 §15 月度复盘 / §16 1.0.0 候选 / §17 参数标定；
// 施工计划 T7.3）。纯本地分析，无自动调度：`pnpm bench-report` 由用户主动触发。
//
// - 定位：开发者手动运行的分析工具——非 OMB runtime，不随 runtime 加载（scripts/ 不在 tsconfig.build
//   include，不产出 lib 产物），不自动后台运行（复盘触发 = 用户主动执行 `pnpm bench-report`）。
// - 产出：workspace/.omb/bench/report-<date>.md（月度复盘 Markdown）+ 控制台摘要。
// - 退出码：0 = 全基准达标（四线齐备 + 全部任务通过）+ 无已知破坏性缺陷；1 = 有未达标项（供 CI/人工检查）。
// - 主逻辑在 main()，仅直接运行时调用（import 无副作用，测试断言——测试 import 的公共 API 经本文件再导出）。
// - 分析与渲染核心在 scripts/bench-report-core.ts（本文件仅 CLI 编排 + 公共 API 再导出，符合 LOC 预算拆分）。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_BENCH_DIR,
  DEFAULT_EVOLUTION_ROOT,
  REPORT_PREFIX,
  computeExitCode,
  ensureBenchReports,
  localDate,
  pct,
  renderMarkdown,
  summarizeEvolution,
  summarizeReports,
  summarizeV2Detail,
} from './bench-report-core.js';

export * from './bench-report-core.js';

const USAGE = `用法：pnpm bench-report [--dir <bench数据目录>]
  默认目录：workspace/.omb/bench/（缺失时跑冻结基准并持久化 bench-<line>.json）
  产出：<dir>/report-<date>.md（月度复盘）+ 控制台摘要
  退出码：0 = 全基准达标 + 无已知破坏性缺陷；1 = 有未达标项`;

/** CLI 主逻辑（仅直接运行时执行；返回退出码，调用方设置 process.exitCode） */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let benchDir = DEFAULT_BENCH_DIR;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' && argv[i + 1] !== undefined) {
      benchDir = argv[i + 1]!;
      i++;
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    }
  }
  const reports = await ensureBenchReports(benchDir);
  const summary = {
    ...summarizeReports(reports),
    evolution: await summarizeEvolution(DEFAULT_EVOLUTION_ROOT),
  };
  // v2 契约基准明细聚合（T2.3：replay-v2-*/real-v2-*.jsonl；只读，不影响 v1 退出码语义）
  const v2 = await summarizeV2Detail(benchDir);
  const date = localDate();
  const md = renderMarkdown(summary, { date, benchDir, v2 });
  const reportFile = join(benchDir, `${REPORT_PREFIX}${date}.md`);
  await mkdir(benchDir, { recursive: true });
  await writeFile(reportFile, md, 'utf8');
  // 控制台摘要
  console.log(
    `OMB v2 月度复盘（${date}）：${summary.resultCount} 结果 / ${summary.passedCount} 通过 / 通过率 ${pct(summary.passRate)}`,
  );
  for (const line of ['initial', 'stable', 'latest', 'baseline'] as const) {
    const s = summary.byLine[line];
    console.log(`  ${line}: ${s.passed}/${s.total} (${pct(s.rate)})`);
  }
  if (v2.present) {
    console.log(`v2 契约基准明细：${v2.files} 文件 / ${v2.records} 条记录`);
    for (const line of ['initial', 'stable', 'latest', 'baseline'] as const) {
      const s = v2.byLine[line];
      if (s.total > 0) {
        console.log(`  v2 ${line}: ${s.passed}/${s.total} (${pct(s.rate)})`);
      }
    }
    // P4：judge 对照摘要（D6 全任务双判；判词/降级/一致率——judge 仅旁证不作晋升硬信号）
    for (const line of ['initial', 'stable', 'latest', 'baseline'] as const) {
      const s = v2.byLine[line];
      if (s.judgeRun + s.judgeDegraded > 0) {
        console.log(
          `  v2 ${line} judge：${s.judgeRun} 判词 / ${s.judgeDegraded} 降级（pass ${s.judgePass} / fail ${s.judgeFail} / unknown ${s.judgeUnknown}，双判一致率 ${pct(s.judgeRate)}）`,
        );
      }
    }
  }
  if (summary.calibration.length > 0) {
    console.log(
      `参数标定建议 ${summary.calibration.length} 条（详见报告 §5）：${summary.calibration[0]!.parameter}`,
    );
  }
  console.log(`报告已写入 ${reportFile}`);
  return computeExitCode(summary);
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
