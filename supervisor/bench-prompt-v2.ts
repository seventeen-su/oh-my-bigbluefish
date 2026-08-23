// OMB v2 基准 v2 提示渲染器（架构 §15 成功标准与基准；施工计划 2026-08-23-bench-v2-contract.md T2.3）：layer 1。
// 确定性纯函数：契约（requirement + output_schema 单一权威）+ fixture.input（具体输入实例）→ prompt 文本。
// 零 I/O、零随机、零外部依赖（仅 import kernel/schemas/ 类型）——同契约同 fixture → 同 prompt（字节级可复现）。
// 与 v1 差异（防 prompt/输入/输出/verifier 四者漂移）：input 不硬编码进生成器，经 fixture.input → renderer →
// prompt；output_schema 序列化进 prompt 作为唯一权威形状（真实执行与 verifier 共享同一 expectation 定义）。
import type {
  BenchContractV2,
  BenchFixtureV2,
  InputArtifactV2,
  OutputSchemaV2,
} from '../kernel/schemas/bench.js';

// ---- 输出 Schema 序列化（prompt 内的唯一权威形状） ----

/** 把 output_schema 序列化为 prompt 文本（2 空格缩进 JSON，确定性；与契约文件同一数据） */
export function renderOutputSchemaPrompt(schema: OutputSchemaV2): string {
  return JSON.stringify(schema, null, 2);
}

// ---- 逐输入工件渲染（fixture.input 的具体实例；确定性） ----

/** json 工件：紧凑 JSON 文本（围栏包裹，与输入数据区分） */
function renderJsonArtifact(artifact: InputArtifactV2): string {
  return `\`\`\`json\n${JSON.stringify(artifact.content)}\n\`\`\``;
}

/** text 工件：原文（content 非字符串 → 防御性序列化） */
function renderTextArtifact(artifact: InputArtifactV2): string {
  const content = artifact.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/** file-list 工件：显式 constraints（path/sorted/recursive，ChatGPT 意见 4）+ 条目清单（path 前缀扫描根） */
function renderFileListArtifact(artifact: InputArtifactV2): string {
  const constraints = artifact.constraints ?? {};
  const root = typeof constraints.path === 'string' ? constraints.path : '?';
  const sorted = String(constraints.sorted === true);
  const recursive = String(constraints.recursive === true);
  const entries = Array.isArray(artifact.content)
    ? artifact.content.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
  const rows = entries.map((item) => {
    const p = typeof item.path === 'string' ? item.path : '';
    return `- ${root}/${p}`;
  });
  return [
    `目录扫描说明：根路径 = ${root}；排序 = ${sorted}；递归 = ${recursive}`,
    '文件清单：',
    ...rows,
  ].join('\n');
}

/** test-cases 工件：language（同组 language 工件，若有）+ 用例表（name/input/expected） */
function renderTestCasesArtifact(artifact: InputArtifactV2, all: readonly InputArtifactV2[]): string {
  const language = all.find((a) => a.name === 'language' && a.kind === 'text');
  const languageLine =
    language === undefined
      ? undefined
      : `语言：${typeof language.content === 'string' ? language.content : JSON.stringify(language.content)}`;
  const cases = Array.isArray(artifact.content) ? artifact.content : [];
  const header = ['用例表：', '| name | input | expected |', '| --- | --- | --- |'];
  const rows = cases.map((testCase) => {
    if (testCase === null || typeof testCase !== 'object' || Array.isArray(testCase)) {
      return '| | | |';
    }
    const record = testCase as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : JSON.stringify(record.name);
    return `| ${name} | ${JSON.stringify(record.input)} | ${JSON.stringify(record.expected)} |`;
  });
  const body = [...header, ...rows].join('\n');
  return languageLine === undefined ? body : `${languageLine}\n${body}`;
}

// ---- 提示组装（确定性纯函数：同契约同 fixture → 同文本） ----

/**
 * v2 执行提示：契约 requirement + 逐输入工件（fixture.input 具体实例）+ 输出指令（output_schema 唯一权威
 * 形状 + 禁止解释文字）。真实执行器（makeRealExecutorV2）与自定义 executor 共用同一渲染路径。
 */
export function renderPromptV2(contract: BenchContractV2, fixture: BenchFixtureV2): string {
  const input = fixture.input;
  const lines: string[] = [];
  lines.push(`# 基准任务 ${contract.id}`);
  lines.push('');
  lines.push('## 要求');
  lines.push(contract.requirement);
  lines.push('');
  lines.push('## 输入');
  for (const artifact of input) {
    lines.push('');
    lines.push(`### 输入工件 ${artifact.name}`);
    lines.push(artifact.description);
    lines.push('');
    switch (artifact.kind) {
      case 'json':
        lines.push(renderJsonArtifact(artifact));
        break;
      case 'text':
        lines.push(renderTextArtifact(artifact));
        break;
      case 'file-list':
        lines.push(renderFileListArtifact(artifact));
        break;
      case 'test-cases':
        lines.push(renderTestCasesArtifact(artifact, input));
        break;
    }
  }
  lines.push('');
  lines.push('## 输出要求');
  lines.push('你必须输出一个符合以下 output_schema 的 JSON 对象（该 schema 是输出形状的唯一权威定义）：');
  lines.push('');
  lines.push(renderOutputSchemaPrompt(contract.output_schema));
  lines.push('');
  lines.push('不要输出 JSON 以外的解释文字。不要长推理，直接给出答案。');
  return lines.join('\n');
}
