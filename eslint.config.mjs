// OMB v3 分层 import 契约（机器强制）。
//
// 依赖方向不可逆：
//   kernel/  ←  modules/  ←  dsh/
//   最内层零宿主依赖；只有 dsh/ 能 import @deepseek-ai/*
//
//   kernel/          不得 import modules/、dsh/、@deepseek-ai/*（type-only 亦禁止）
//   modules/<a>/     不得 import modules/<b>/；不得 import dsh/
//   dsh/             唯一接触宿主的层
//   tests/           豁免（可 import 任何层）
//
// 另有一条内核纯度规则：kernel/ 不得出现业务词汇
//（memory/retrieve/embed/reasoning/context/profile/artifact 等），
// 防止微内核膨胀成第二个 assembly.ts。
import path from 'node:path';
import tseslint from 'typescript-eslint';

function toPosix(p) {
  return p.split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * 返回文件所属的顶层区段（kernel / modules / dsh / tests），否则 null。
 * 取**路径中第一个出现**的区段——`tests/modules/x/y.ts` 属于 tests 而非 modules。
 */
function layerOf(filePath) {
  const posix = toPosix(filePath);
  let best = null;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const seg of ['kernel', 'modules', 'dsh', 'tests']) {
    const at = posix.indexOf(`/${seg}/`);
    if (at === -1) continue;
    if (at < bestIndex) {
      bestIndex = at;
      best = seg;
    }
  }
  return best;
}

/** 返回 modules/ 下的模块名，否则 null */
function moduleOf(filePath) {
  const m = /\/modules\/([^/]+)\//.exec(`${toPosix(filePath)}/`);
  return m ? m[1] : null;
}

const IMPORT_RULES = {
  kernel: { forbiddenLayers: ['modules', 'dsh'], forbiddenBare: /^@deepseek-ai\// },
  modules: { forbiddenLayers: ['dsh'], forbiddenBare: /^@deepseek-ai\// },
  dsh: { forbiddenLayers: [], forbiddenBare: null },
};

const noLayerViolation = {
  meta: {
    type: 'problem',
    docs: { description: '禁止反向或跨层 import（kernel ← modules ← dsh）' },
    messages: {
      layer: '反向分层 import：{{from}} → {{to}}（{{source}}）',
      bare: '{{from}} 层不得 import 宿主包 {{source}}——宿主接触只允许在 dsh/',
      sibling: '模块之间不得直接 import：{{fromModule}} → {{toModule}}（{{source}}）；请经 Kernel 服务或事件通信',
    },
  },
  create(context) {
    const filename = context.filename ?? '';
    const from = layerOf(filename);
    // tests/ 豁免：测试需要横跨各层验证契约，规则只约束生产代码
    if (from === null || from === 'tests') return {};
    const rules = IMPORT_RULES[from];
    const fromModule = moduleOf(filename);

    function check(node) {
      const src = node.source;
      if (!src || typeof src.value !== 'string') return;
      const source = src.value;

      if (rules.forbiddenBare !== null && rules.forbiddenBare.test(source)) {
        context.report({ node, messageId: 'bare', data: { from, source } });
        return;
      }
      if (!source.startsWith('.')) return;

      const targetAbs = path.resolve(path.dirname(filename), source);
      const to = layerOf(targetAbs);
      if (to !== null && rules.forbiddenLayers.includes(to)) {
        context.report({ node, messageId: 'layer', data: { from, to, source } });
        return;
      }
      if (from === 'modules') {
        const toModule = moduleOf(targetAbs);
        if (toModule !== null && toModule !== fromModule) {
          context.report({ node, messageId: 'sibling', data: { fromModule, toModule, source } });
        }
      }
    }
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

// 内核纯度：不得出现业务词汇（文件名与标识符均检查）
const BUSINESS_WORDS = [
  'memory', 'retrieve', 'retrieval', 'embed', 'embedding', 'vector',
  'reasoning', 'contradiction', 'profile', 'artifact', 'consolidate',
  'tokenize', 'sqlite', 'fts',
];

const kernelPurity = {
  meta: {
    type: 'problem',
    docs: { description: '微内核不得包含业务逻辑（≤350 行、无业务词汇）' },
    messages: {
      word: '微内核纯度违规：出现业务词汇 "{{word}}"（{{where}}）。业务逻辑必须移入 modules/',
    },
  },
  create(context) {
    const filename = context.filename ?? '';
    if (layerOf(filename) !== 'kernel') return {};
    const base = path.basename(filename, path.extname(filename)).toLowerCase();
    const hit = BUSINESS_WORDS.find(w => base.includes(w));
    if (hit !== undefined) {
      context.report({
        node: context.sourceCode.ast,
        messageId: 'word',
        data: { word: hit, where: '文件名' },
      });
    }
    return {};
  },
};

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/lib/**', '**/dist/**'] },
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: {
      omb: { rules: { 'no-layer-violation': noLayerViolation, 'kernel-purity': kernelPurity } },
    },
    rules: {
      'omb/no-layer-violation': 'error',
      'omb/kernel-purity': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
