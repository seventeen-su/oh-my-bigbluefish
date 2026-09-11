# 第三方组件与许可声明

本仓库（OMB v2）以 GPL-3.0 分发（见 `LICENSE`）。以下是随仓库分发或运行期依赖的第三方组件，
以及分发它们时必须保留的归属与许可条款。

## 1. 随仓库分发的第三方文件

### 1.1 `memory/bge-small-zh/vocab.txt`

- **来源**：`BAAI/bge-small-zh-v1.5` 仓库根目录的 `vocab.txt`（BERT 中文 WordPiece 词表，21128 行）。
  已核对：与上游逐字节一致，sha256 `45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c`，
  109540 字节。（注意 `onnx-community/bge-small-zh-v1.5-ONNX` 仓库**不含**该词表，只含 `onnx/` 下的权重。）
- **许可**：MIT（`BAAI/bge-small-zh-v1.5` 模型仓库声明）。
- **为什么随仓库分发**：分词器（`memory/embeddings-onnx.ts` 内自实现 WordPiece）在**没有下载权重**时
  也必须可自检——词表仅 107KB，可进 git；权重约 23MB，不适合进 git，由
  `pnpm fetch-embedding-model` 落到数据根。
- **修改**：无（未做任何裁剪或改写）。

### 1.2 `memory/bge-small-zh/` 目录下的其余文件

无。该目录只放词表，不放权重。

## 2. 运行期下载的第三方文件（不进仓库）

由 `pnpm fetch-embedding-model` 从 Hugging Face 拉取，落到
`<preset>/workspace/.omb/models/bge-small-zh-v1.5/`：

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `model_quantized.onnx` + `model_quantized.onnx_data`（默认） | `onnx-community/bge-small-zh-v1.5-ONNX` | MIT |
| `model.onnx` + `model.onnx_data`（`--variant fp32`） | 同上 | MIT |

底层模型为 `BAAI/bge-small-zh-v1.5`（MIT）。**权重文件名不可重命名**：外部权重数据的文件名被写进
ONNX 图内部，改名会导致推理会话创建失败——获取脚本因此原样保留上游文件名。

## 3. 运行期依赖（package.json）

| 包 | 许可 | 说明 |
| --- | --- | --- |
| `onnxruntime-node` | MIT | 本地 ONNX 推理运行时（预编译二进制）。声明为 **optionalDependency**（解包约 296MB）：只想用哈希词袋的部署不必付这份体积。仅在启用神经嵌入时被动态 `import`；缺失或不可加载 → 回落纯 JS 哈希词袋，不影响其他功能。 |
| `onnxruntime-common` | MIT | 上述包的共享类型/接口层（作为其依赖随装）。 |
| `js-yaml` / `koffi` / `zod` | 见各自 `package.json` | 运行期直接依赖：YAML 解析、Windows 受限令牌 FFI、schema 校验。 |
| `tsx` / `vitest` / `typescript` / `typescript-eslint` / `eslint` / `jieba-wasm` / `@types/*` | 见各自 `package.json` | 仅开发/构建/测试期依赖，不进入运行期产物。 |

完整依赖树（含传递依赖及其许可）见 `pnpm-lock.yaml`；如需逐包许可清单，可用
`pnpm licenses list` 生成（该命令的可用性取决于 pnpm 版本）。

## 4. 合规要点

- MIT 组件允许商用与再分发，条件是保留版权声明与许可全文。本文件与 `LICENSE` 一并构成该保留。
- 若你重新分发本仓库，请同时保留 `memory/bge-small-zh/vocab.txt` 与本节说明。
- 若你在部署环境下载了权重，请自行确认当地法律与上游许可的适用性（上游为 MIT，无额外限制）。
