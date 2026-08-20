// OMB v2 preset 的 ESLint 9 flat config + 层 DAG lint 自定义规则。
//
// 层 DAG（依赖方向，反向 import 禁止，CONVENTIONS §4）：
//   substrate(0) → supervisor(1) → kernel/runtime/memory(2) → components(3)
// 规则：import 目标路径所在层 ≤ 源文件所在层，否则报错。
// 豁免：tests/ 内文件；非相对 import（bare specifier，如 vitest / node:fs）。
import path from 'node:path';
import tseslint from 'typescript-eslint';

const LAYER_INDEX = {
  substrate: 0,
  supervisor: 1,
  kernel: 2,
  runtime: 2,
  memory: 2,
  components: 3,
};

/** 分隔符统一为 '/'（Windows 反斜杠也处理） */
function toPosix(p) {
  return p.split(path.sep).join('/').replace(/\\/g, '/');
}

/** 路径命中层段（如 /substrate/）则返回层号；不在任何层 → null（豁免） */
function detectLayer(filePath) {
  const posix = toPosix(filePath);
  for (const [segment, layer] of Object.entries(LAYER_INDEX)) {
    if (posix.includes(`/${segment}/`)) {
      return layer;
    }
  }
  return null;
}

const noCrossLayerImport = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '禁止跨层向上 import（层 DAG：substrate→supervisor→kernel/runtime/memory→components）',
    },
    messages: {
      crossLayer: 'Cross-layer import forbidden: layer {{fromLayer}} → layer {{toLayer}}（{{source}}）',
    },
  },
  create(context) {
    function check(node) {
      const sourceNode = node.source;
      if (!sourceNode || typeof sourceNode.value !== 'string') {
        return;
      }
      const source = sourceNode.value;
      // 非相对 import（bare specifier）豁免
      if (!source.startsWith('.')) {
        return;
      }
      const filename = context.filename ?? '';
      // tests/ 内文件豁免（可 import 任意层）
      if (toPosix(filename).includes('/tests/')) {
        return;
      }
      const fromLayer = detectLayer(filename);
      if (fromLayer === null) {
        return; // 源文件不在任何层 → 豁免
      }
      const targetAbs = path.resolve(path.dirname(filename), source);
      const toLayer = detectLayer(targetAbs);
      if (toLayer === null) {
        return; // 目标不在任何层（如 import 到 preset 外）→ 豁免
      }
      if (toLayer > fromLayer) {
        // 例外（主会话裁决 2026-08-21）：IR 契约层——仅 supervisor(1) → kernel/schemas/ 放行
        //（IR 为跨层机器契约；supervisor → kernel 其他路径与 kernel → supervisor 仍禁止）
        const schemasContract = toPosix(targetAbs).includes('/kernel/schemas/');
        const contractException = fromLayer === 1 && toLayer === 2 && schemasContract;
        if (!contractException) {
          context.report({
            node,
            messageId: 'crossLayer',
            data: { fromLayer: String(fromLayer), toLayer: String(toLayer), source },
          });
        }
      }
    }
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/lib/**'],
  },
  tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts'],
    plugins: {
      omb: { rules: { 'no-cross-layer-import': noCrossLayerImport } },
    },
    rules: {
      'omb/no-cross-layer-import': 'error',
    },
  },
);
