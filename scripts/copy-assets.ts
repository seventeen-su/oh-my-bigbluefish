// 构建期资产同步：把 tsc **不会**产出的非 TS 资产拷进 lib/。
//
// 为什么需要这一步（生产事故级）：`tsc` 只编译 .ts → .js，不搬任何其它文件。而插件入口是编译产物
// （`agent.cordis.yml` 的 `name: './lib/runtime/plugin.js?v=N'`），于是靠 `import.meta.url` 定位
// 资产的分支在编译布局下全部指向 lib/ 下不存在的路径。已实测的后果：神经嵌入的中文词表
// （`memory/bge-small-zh/vocab.txt`）在 lib/ 里不存在 → WordPiece 装载抛 ENOENT → 嵌入器**永久**
// 回落哈希词袋（功能等于没接上），而唯一写下的降级原因是"词表装载失败"——把"打包丢了资产"误报成
// "模型资产有问题"。
//
// 本脚本是构建流程的一部分（`pnpm build` = `tsc` + 本脚本），逐条登记需要同步的资产，
// 缺源文件即**非 0 退出**（静默漏掉资产正是这次要根除的失效模式）。
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRESET_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(PRESET_ROOT, 'lib');

/** 需要随构建产物一起落地的资产（源相对 preset 根 → 目标相对 lib/；逐条写清用途） */
const ASSETS: ReadonlyArray<{ from: string; to: string; why: string }> = [
  {
    from: 'memory/bge-small-zh/vocab.txt',
    to: 'memory/bge-small-zh/vocab.txt',
    why: 'BERT WordPiece 中文词表（分词必需，靠 import.meta.url 定位）',
  },
];

function main(): void {
  if (!existsSync(OUT_DIR)) {
    throw new Error(`构建产物目录不存在：${OUT_DIR}（请先跑 tsc -p tsconfig.build.json）`);
  }
  const missing: string[] = [];
  for (const asset of ASSETS) {
    const src = join(PRESET_ROOT, asset.from);
    if (!existsSync(src)) {
      missing.push(`${asset.from}（${asset.why}）`);
      continue;
    }
    const dest = join(OUT_DIR, asset.to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
    console.log(`[copy-assets] ${asset.from} → lib/${asset.to}`);
  }
  if (missing.length > 0) {
    // fail-loud：资产缺失必须让构建失败，否则又回到"构建成功但功能静默不可用"
    throw new Error(`构建资产缺失（${missing.length} 项）：\n  - ${missing.join('\n  - ')}`);
  }
  console.log(`[copy-assets] 完成：${ASSETS.length} 项资产已同步到 lib/`);
}

try {
  main();
} catch (err) {
  console.error(`[copy-assets] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
