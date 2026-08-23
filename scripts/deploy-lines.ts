// OMB v2 三线部署 CLI 入口（developer tooling）：`pnpm deploy-lines`。
// 生成三个 per-line 预设目录（omb-v2-initial/stable/latest）到 $DSH_HOME/.agent-presets/，
// 使 /mode 切换可真实 recompose 重链到对应线预设（插件 presetIdForLine 映射；未部署时降级为会话内状态）。
// 主逻辑在 main()，仅直接运行时执行（import 无副作用，测试 import 的公共 API 经本文件再导出）。
// 纯逻辑核心在 scripts/deploy-lines-core.ts（本文件仅 CLI 编排 + 公共 API 再导出，仿 scripts/bench-report.ts）。
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planLinePresets } from './deploy-lines-core.js';

export * from './deploy-lines-core.js';

const USAGE = `用法：pnpm deploy-lines [--home <dshHome>]
  缺省 dshHome：$env:DSH_HOME（优先）→ <用户主目录>/.dsh
  产出：<dshHome>/.agent-presets/omb-v2-<initial|stable|latest>/（覆盖式生成 per-line 预设）
  退出码：0 = 三线全部写入成功；1 = 任一步失败
  部署后 /mode 切换可真实 recompose 重链到对应线预设；未部署时 /mode 降级为会话内版本线状态`;

/** CLI 主逻辑（仅直接运行时执行；返回退出码，调用方设置 process.exitCode） */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const envHome = process.env.DSH_HOME;
  let dshHome = envHome !== undefined && envHome.trim().length > 0 ? envHome : join(homedir(), '.dsh');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--home' && argv[i + 1] !== undefined) {
      dshHome = argv[i + 1]!;
      i++;
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    }
  }
  const presetRoot = fileURLToPath(new URL('..', import.meta.url));
  try {
    const plans = planLinePresets(presetRoot, dshHome);
    for (const plan of plans) {
      for (const file of plan.files) {
        await mkdir(plan.dir, { recursive: true });
        await writeFile(join(plan.dir, file.name), file.content, 'utf8');
        console.log(`已更新 ${join(plan.dir, file.name)}`);
      }
    }
    for (const plan of plans) {
      console.log(`预设目录：${plan.dir}`);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
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
