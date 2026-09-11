// 向量模型获取脚本（部署动作，一次即可）：把 BGE-small-zh-v1.5（ONNX 量化版）落到数据根。
//
// 为什么是脚本而不是"随仓库分发"：权重约 23MB（量化）/ 90MB（fp32）——二进制大文件不适合进 git
// （clone 变慢、历史膨胀且无法有效 diff）。词表（107KB，分词必需）随仓库分发；权重用本脚本取。
//
// 用法：
//   pnpm fetch-embedding-model                     # 落到 <preset>/workspace/.omb/models/bge-small-zh-v1.5/
//   pnpm fetch-embedding-model --dir <目标目录>     # 自定义目录（等价于设 OMB_EMBEDDING_MODEL）
//   pnpm fetch-embedding-model --variant fp32      # 取未量化版（质量略高、体积约 90MB）
//   pnpm fetch-embedding-model --verify            # 对已存在文件强制校验 sha256（默认只校验新下载的）
//
// 环境无关：默认走 Hugging Face；中国大陆网络可用 `OMB_MODEL_MIRROR=https://hf-mirror.com` 走镜像。
//
// 幂等与完整性：**保留上游文件名**（`model_quantized.onnx` + `model_quantized.onnx_data`）。
// 外部权重文件名被写进了 ONNX 图内部（图里记录的是 `model_quantized.onnx_data`），改名会让
// 会话创建直接失败——所以本脚本不做任何重命名，只把 `onnx/` 前缀去掉。
// 每个文件都取上游 LFS 指针里的 sha256，落盘后比对；不一致 → 删除并报错（不静默留半份模型）。
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（src 布局 <preset>/scripts/ → 上一级；编译布局 <preset>/lib/scripts/ → 再上一级） */
const HERE = fileURLToPath(new URL('..', import.meta.url));
const PRESET_ROOT = existsSync(join(HERE, 'kernel', 'policy')) ? HERE : dirname(HERE);

/** 默认数据根（与 assembly 的 root 口径一致：<preset>/workspace/.omb） */
const DEFAULT_DIR = join(PRESET_ROOT, 'workspace', '.omb', 'models', 'bge-small-zh-v1.5');
/** 上游仓库（社区 ONNX 转换；MIT 许可，模型为 BAAI/bge-small-zh-v1.5） */
const REPO = 'onnx-community/bge-small-zh-v1.5-ONNX';

/** 变体 → 需要下载的文件（onnx 与其外部权重数据分开存放；顺序即落盘顺序） */
const VARIANTS = {
  quantized: ['onnx/model_quantized.onnx', 'onnx/model_quantized.onnx_data'],
  fp32: ['onnx/model.onnx', 'onnx/model.onnx_data'],
} as const;
type Variant = keyof typeof VARIANTS;

interface Args {
  dir: string;
  variant: Variant;
  verify: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let dir = DEFAULT_DIR;
  let variant: Variant = 'quantized';
  let verify = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') {
      const v = argv[++i];
      if (v === undefined || v.length === 0) throw new Error('--dir 需要目录参数');
      dir = resolve(v);
    } else if (a === '--variant') {
      const v = argv[++i];
      if (v !== 'quantized' && v !== 'fp32') throw new Error(`--variant 只支持 quantized|fp32（收到 ${String(v)}）`);
      variant = v;
    } else if (a === '--verify') {
      verify = true;
    } else if (a === '--help' || a === '-h') {
      console.log(
        '用法: pnpm fetch-embedding-model [--dir <目录>] [--variant quantized|fp32] [--verify]\n' +
          '环境变量: OMB_MODEL_MIRROR（镜像前缀，如 https://hf-mirror.com）',
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }
  return { dir, variant, verify };
}

function mirrorBase(): string {
  const m = process.env.OMB_MODEL_MIRROR;
  return typeof m === 'string' && m.length > 0 ? m.replace(/\/+$/, '') : 'https://huggingface.co';
}

function sha256File(path: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

/**
 * 取上游期望的 sha256 与大小。
 * Hugging Face 通过 LFS 指针（`oid sha256:<hex>` / `size <n>`）暴露这两个值，
 * **不需要把 23MB 权重拉下来就能校验**——这是"下载完整性"最省带宽的判据。
 * 镜像不支持 LFS 指针（直接回二进制）→ 返回 undefined，退化为"按实际内容记账"。
 */
async function upstreamExpectation(url: string): Promise<{ sha256?: string; size?: number }> {
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return {};
    const len = r.headers.get('content-length');
    const declared = len === null ? undefined : Number.parseInt(len, 10);
    // 只有小响应才可能是文本指针；大响应说明镜像直接给了二进制
    if (declared === undefined || declared > 4096) {
      return { size: declared };
    }
    const text = await r.text();
    const oid = /oid sha256:([0-9a-f]{64})/.exec(text);
    const size = /size (\d+)/.exec(text);
    if (oid === null || oid[1] === undefined) return { size: declared };
    return {
      sha256: oid[1],
      size: size === null || size[1] === undefined ? declared : Number.parseInt(size[1], 10),
    };
  } catch {
    return {};
  }
}

type Outcome = 'skipped' | 'downloaded';

/** 单文件下载（流式 → 临时文件 → 校验 → rename；已存在且校验通过 → 跳过） */
async function fetchFile(
  url: string,
  dest: string,
  expect: { sha256?: string; size?: number },
  forceVerify: boolean,
): Promise<Outcome> {
  if (existsSync(dest)) {
    const size = statSync(dest).size;
    const sizeOk = expect.size === undefined ? size > 0 : size === expect.size;
    if (sizeOk && expect.sha256 !== undefined) {
      // 有权威哈希就校验：判断"文件是否已是目标内容"的成本远低于重下 23MB。
      if (sha256File(dest) === expect.sha256) return 'skipped';
      console.log(`  校验失败，重新下载：${basename(dest)}`);
    } else if (sizeOk) {
      // 无权威哈希（镜像不给 LFS 指针）→ 只能按大小判断；--verify 也救不了，如实说明。
      if (forceVerify) console.log(`  无上游哈希可比，按大小视为完整：${basename(dest)}`);
      return 'skipped';
    }
  }
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  rmSync(tmp, { force: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || res.body === null) {
    throw new Error(`下载失败 ${url} → HTTP ${res.status} ${res.statusText}`);
  }
  const out = createWriteStream(tmp);
  const reader = res.body.getReader();
  let written = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      written += buf.byteLength;
      await new Promise<void>((ok, bad) => out.write(buf, (e) => (e ? bad(e) : ok())));
    }
    await new Promise<void>((ok) => out.end(ok));
  } catch (err) {
    out.destroy();
    rmSync(tmp, { force: true });
    throw err;
  }
  if (expect.size !== undefined && written !== expect.size) {
    rmSync(tmp, { force: true });
    throw new Error(`下载不完整 ${url}（${written} ≠ ${expect.size} 字节）——已删除半份文件`);
  }
  if (expect.sha256 !== undefined) {
    const got = sha256File(tmp);
    if (got !== expect.sha256) {
      rmSync(tmp, { force: true });
      throw new Error(`下载内容校验失败 ${url}（sha256 ${got.slice(0, 12)}… ≠ ${expect.sha256.slice(0, 12)}…）——已删除`);
    }
  }
  renameSync(tmp, dest);
  return 'downloaded';
}

function humanSize(bytes: number | undefined): string {
  if (bytes === undefined) return '未知大小';
  return bytes >= 1048576 ? `${Math.round(bytes / 1048576)}MB` : `${bytes}B`;
}

/**
 * 探测推理运行时是否可加载。
 * `onnxruntime-node` 是 **optionalDependency**（解包约 296MB）：只想用哈希词袋的部署不必付这份体积。
 * 但"下了权重却没装运行时"是个哑失败——运行时只会降级且原因埋在状态面里，所以这里主动提示。
 */
async function runtimeAvailable(): Promise<boolean> {
  try {
    await import('onnxruntime-node');
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base = `${mirrorBase()}/${REPO}/resolve/main`;
  console.log(`[fetch-embedding-model] 变体=${args.variant} 目标=${args.dir}`);
  console.log(`[fetch-embedding-model] 来源=${base}（镜像前缀可用 OMB_MODEL_MIRROR 覆盖）`);
  for (const remote of VARIANTS[args.variant]) {
    const local = basename(remote); // 不重命名：外部权重文件名被记在图内部
    const url = `${base}/${remote}`;
    const expect = await upstreamExpectation(url);
    const r = await fetchFile(url, join(args.dir, local), expect, args.verify);
    console.log(`  ${remote} → ${local}：${r === 'skipped' ? '已就绪，跳过' : `已下载 ${humanSize(expect.size)}`}`);
  }
  console.log('[fetch-embedding-model] 完成。词表随仓库分发（memory/bge-small-zh/vocab.txt），无需下载。');
  console.log(`[fetch-embedding-model] 若目标目录非默认，请设 OMB_EMBEDDING_MODEL=${args.dir} 或配置插件 embeddingModelDir。`);
  if (await runtimeAvailable()) {
    console.log('[fetch-embedding-model] 推理运行时 onnxruntime-node 可用，重启会话后即启用神经嵌入。');
  } else {
    console.warn(
      '[fetch-embedding-model] 警告：推理运行时 onnxruntime-node 不可加载——权重下了也不会生效（会回落哈希词袋）。\n' +
        '  它是 optionalDependency（解包约 296MB），本仓库默认不强制安装。装上即可：\n' +
        '    pnpm add -O onnxruntime-node@1.29.0 --fetch-timeout 1800000 --fetch-retries 5',
    );
  }
}

main().catch((err: unknown) => {
  console.error(`[fetch-embedding-model] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
