// OMB v3 分层 import 契约（机器强制）。
//
// 依赖方向不可逆：
//   kernel/  ←  modules/  ←  dsh/  ←  packages/
//   最内层零宿主依赖；只有 dsh/ 能 import @deepseek-ai/*
//
//   kernel/          不得 import modules/、dsh/、packages/、@deepseek-ai/*（type-only 亦禁止）
//   modules/<a>/     不得 import modules/<b>/；不得 import dsh/、packages/
//   dsh/             唯一接触宿主的层；不得 import packages/（组件包在最外层）
//   packages/<组件>/ 组件包入口：只做 re-export + default 包装，可 import 下三层
//   tests/           豁免（可 import 任何层）
//
// 另有一条内核纯度规则 `omb/kernel-purity`：kernel/ 不得出现业务词汇
//（memory/retrieve/embed/reasoning/context/profile/artifact 等），
// 防止微内核膨胀成第二个 assembly.ts。它的三条判据都在**代码里**：
//   ① 文件名含业务词汇 → 报错
//   ② 标识符含业务词汇 → 报错（带位置；`kernel/abi/**` 是契约层，见下方豁免常量）
//   ③ 行数超过 `KERNEL_LINE_BUDGET` → 报错（豁免名单见下方常量）
// 三条一起生效；上限与豁免名单是**导出的常量**，文档与测试都核对它们
// （`tests/kernel/kernel-purity.test.ts`），所以"文档说 350、代码不查"这类
// 中间态不会再出现——要么代码查，要么连文档一起改。
//
// 注意 `packages/kernel/` 这类路径**同时**含 `/packages/` 与 `/kernel/` 段；
// layerOf 取最早出现的段，因此它属于 packages（组件包层），不会被内核纯度规则误判。
import path from 'node:path';
import tseslint from 'typescript-eslint';

function toPosix(p) {
  return p.split(path.sep).join('/').replace(/\\/g, '/');
}

/**
 * 返回文件所属的顶层区段（packages / kernel / modules / dsh / tests），否则 null。
 * 取**路径中第一个出现**的区段——`tests/modules/x/y.ts` 属于 tests 而非 modules，
 * `packages/kernel/index.ts` 属于 packages 而非 kernel。
 */
function layerOf(filePath) {
  const posix = toPosix(filePath);
  let best = null;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const seg of ['packages', 'kernel', 'modules', 'dsh', 'tests']) {
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
  packages: { forbiddenLayers: [], forbiddenBare: /^@deepseek-ai\// },
  kernel: { forbiddenLayers: ['modules', 'dsh', 'packages'], forbiddenBare: /^@deepseek-ai\// },
  modules: { forbiddenLayers: ['dsh', 'packages'], forbiddenBare: /^@deepseek-ai\// },
  dsh: { forbiddenLayers: ['packages'], forbiddenBare: null },
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

// 内核纯度：不得出现业务词汇（**文件名与标识符都查**），且不得超过行数预算
const BUSINESS_WORDS = [
  'memory', 'retrieve', 'retrieval', 'embed', 'embedding', 'vector',
  'reasoning', 'contradiction', 'profile', 'artifact', 'consolidate',
  'tokenize', 'sqlite', 'fts',
];

/**
 * 内核代码行数预算。
 *
 * **这是唯一的数字真源**：`docs/omb-v3-refactor-plan.md` 里写的上限必须与它一致
 * （测试 `tests/kernel/kernel-purity.test.ts` 逐字核对）。改这里就要改文档，
 * 否则测试失败——理由是这个项目上出现过"文档把它当作风险缓解措施、
 * 而代码一行都没查"的中间态（`kernel/index.ts` 到 723 行仍全绿）。
 */
export const KERNEL_LINE_BUDGET = 350;

/**
 * 行数预算的**明文豁免**（相对 `kernel/` 的路径；`/` 结尾表示整棵子树）。
 *
 * 豁免不是"先欠着"：每一条都要说出为什么它**不应该**被拆。
 * 名单必须与 `docs/omb-v3-refactor-plan.md` 里列的逐字一致（测试会核对）。
 */
export const KERNEL_LINE_BUDGET_EXEMPT = [
  // 契约声明：把宿主与模块提供的全部服务、事件、能力列成表。它是"名字表"不是逻辑，
  // 行数随能力面增长，拆成多文件只会让 ABI 的形状更难一眼看全。
  'abi/',
  // 装配：内核与宿主、模块的接线点都在这里（行数随模块数增长，逻辑都在 modules/）。
  'index.ts',
  // 宿主入口：DSH 生命周期与内核之间的适配层，行数随宿主 API 面增长。
  'hostEntry.ts',
];

/**
 * 标识符检查的豁免（相对 `kernel/` 的路径前缀）。
 *
 * `abi/**` 的**职责就是**给业务侧的端口与服务命名（`embedder`/`profile`/`artifact`/
 * `vectorEncoder`…）——那是契约的语言，不是内核里的业务逻辑。内核不因此多出一行业务实现：
 * 实现方全在 `modules/`，ABI 只有类型。
 */
export const KERNEL_IDENTIFIER_EXEMPT = ['abi/'];

/** 文件是否落在某个"前缀或整文件"的豁免名单里。 */
function isExempt(relative, list) {
  return list.some(entry => (entry.endsWith('/') ? relative.startsWith(entry) : relative === entry));
}

/** `kernel/` 下的相对路径（posix），用于匹配豁免名单。 */
function kernelRelativeOf(filePath) {
  const posix = toPosix(filePath);
  const at = posix.indexOf('/kernel/');
  return at === -1 ? posix : posix.slice(at + '/kernel/'.length);
}

const kernelPurity = {
  meta: {
    type: 'problem',
    docs: {
      description: `微内核不得包含业务逻辑（≤${KERNEL_LINE_BUDGET} 行、无业务词汇；豁免名单见 eslint.config.mjs 的 KERNEL_LINE_BUDGET_EXEMPT / KERNEL_IDENTIFIER_EXEMPT）`,
    },
    messages: {
      word: '微内核纯度违规：出现业务词汇 "{{word}}"（{{where}}）。业务逻辑必须移入 modules/',
      lines: '微内核超出代码预算：{{file}} 有 {{lines}} 行 > {{budget}} 行。'
        + '要么把逻辑移入 modules/，要么把"为什么不该拆"写进 eslint.config.mjs 的 KERNEL_LINE_BUDGET_EXEMPT 并同步改 docs/omb-v3-refactor-plan.md',
    },
  },
  create(context) {
    const filename = context.filename ?? '';
    if (layerOf(filename) !== 'kernel') return {};
    const relative = kernelRelativeOf(filename);

    // 判据 ①：文件名
    const base = path.basename(filename, path.extname(filename)).toLowerCase();
    const nameHit = BUSINESS_WORDS.find(w => base.includes(w));
    if (nameHit !== undefined) {
      context.report({
        node: context.sourceCode.ast,
        messageId: 'word',
        data: { word: nameHit, where: '文件名' },
      });
    }

    // 判据 ③：行数。用"最后一个非空行"的行号——`getLines()` 会把结尾换行后的空串
    // 也算一行，直接取 length 会与 `wc -l` 差 1，读数字的人会以为边界写错了。
    if (!isExempt(relative, KERNEL_LINE_BUDGET_EXEMPT)) {
      const lines = context.sourceCode.getLines();
      let lastContent = lines.length;
      while (lastContent > 0 && (lines[lastContent - 1] ?? '').trim() === '') lastContent -= 1;
      if (lastContent > KERNEL_LINE_BUDGET) {
        context.report({
          node: context.sourceCode.ast,
          messageId: 'lines',
          data: { file: `kernel/${relative}`, lines: lastContent, budget: KERNEL_LINE_BUDGET },
        });
      }
    }

    if (isExempt(relative, KERNEL_IDENTIFIER_EXEMPT)) return {};

    // 判据 ②：标识符与属性名。为什么查标识符而不只查文件名：往内核里写
    // `const memoryStore = …` 不会改变文件名——只查文件名等于这条判据不存在。
    // 同一个节点只报一次（简写属性 `{ memory }` 的键与值指向同一个节点）。
    const reported = new Set();
    const reportWord = (node, raw) => {
      if (reported.has(node)) return;
      const hit = BUSINESS_WORDS.find(w => raw.toLowerCase().includes(w));
      if (hit === undefined) return;
      reported.add(node);
      context.report({ node, messageId: 'word', data: { word: hit, where: `标识符 ${raw}` } });
    };
    return {
      Identifier(node) {
        reportWord(node, node.name);
      },
      Property(node) {
        // 字符串键（`{ 'memory/written': … }`）与计算键不走 Identifier 访问器，这里补上；
        // 只查键不查值——值是数据，不是命名。
        if (node.key.type === 'Literal' && typeof node.key.value === 'string') {
          reportWord(node.key, node.key.value);
        }
      },
    };
  },
};

// 模块层禁止直接读时钟：一律经 `kernel.clock`。
// 理由：测试要可控时钟；且"模块层不许有隐式环境依赖"是内核/模块边界的可检查形式。
const noDirectClock = {
  meta: {
    type: 'problem',
    docs: { description: '模块层禁止直接使用 Date.now()/new Date()，一律经 kernel.clock' },
    messages: {
      direct: '模块层不得直接取时间（{{what}}）——用 kernel.clock.now()，测试需要可控时钟',
    },
  },
  create(context) {
    const filename = context.filename ?? '';
    if (layerOf(filename) !== 'modules') return {};
    return {
      MemberExpression(node) {
        if (node.object?.name === 'Date' && node.property?.name === 'now') {
          context.report({ node, messageId: 'direct', data: { what: 'Date.now()' } });
        }
      },
      NewExpression(node) {
        if (node.callee?.name === 'Date') {
          context.report({ node, messageId: 'direct', data: { what: 'new Date()' } });
        }
      },
    };
  },
};

export default tseslint.config(
  // `lib-gen/` 是构建产物（不入库），不该每轮被扫一遍。
  { ignores: ['**/node_modules/**', '**/lib/**', '**/dist/**', '**/lib-gen/**'] },
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: {
      omb: {
        rules: {
          'no-layer-violation': noLayerViolation,
          'kernel-purity': kernelPurity,
          'no-direct-clock': noDirectClock,
        },
      },
    },
    rules: {
      'omb/no-layer-violation': 'error',
      'omb/kernel-purity': 'error',
      'omb/no-direct-clock': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // `scripts/*.mjs` 此前**一条规则都不跑**：唯一带 rules 的块限定 `**/*.ts`，
    // 而 typescript-eslint 的 recommended 只作用于 ts/tsx/mts/cts。
    // 但 `scripts/build.mjs` 是唯一决定发布产物形状的代码——未使用的导入、
    // 拼错的属性名都会静默通过。这里给它（以及根目录的 .mjs）一层最小核心规则。
    // 不引 `@eslint/js` 的 recommended：那会一次性打开几十条与既有风格无关的规则，
    // 把"补一个真实盲区"变成"重排整个脚本目录的风格"。
    files: ['**/*.mjs'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      'no-self-assign': 'error',
    },
  },
);
