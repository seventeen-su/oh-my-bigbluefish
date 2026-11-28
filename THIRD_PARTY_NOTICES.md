# Third-Party Notices / 第三方组件与许可声明

Oh-My-bigbluefish is licensed under the GNU General Public License, version 3 only (GPL-3.0-only). This file lists third-party components and the license terms that apply to them. The licenses below remain in effect; nothing in this file changes those terms.

The third-party licenses used here are compatible with GPL-3.0-only. MIT and PostgreSQL License components are permissive; the Apache-2.0 component is used as a separate runtime dependency and is compatible with GPLv3. The BGE model is distributed under MIT and is included with its own notice.

## Distributed with this package

| Component | Version | License | Source |
|---|---:|---|---|
| BGE-small-zh-v1.5 | 1.5 | MIT | https://huggingface.co/BAAI/bge-small-zh-v1.5 |

The ONNX model files and vocabulary in `models/bge-small-zh-v1.5/` come from BAAI BGE-small-zh-v1.5. The model card and license are published at the source above. The model is redistributed without modification.

## Runtime dependencies

These packages are installed by the DSH profile and are not bundled into the plugin artifact.

| Component | Version | License |
|---|---:|---|
| pg | 8.23.1 | PostgreSQL License |
| pg-boss | 12.39.0 | MIT |
| quickjs-emscripten | 0.32.0 | MIT |
| zod | 4.6.7 | MIT |
| @opentelemetry/api | 1.9.0 | Apache-2.0 |
| onnxruntime-node | 1.29.0 | MIT |

## Host and database components

DeepSeek Harness is licensed under the MIT License. Its source and notices are published at https://github.com/deepseek-ai/deepseek-harness.

PostgreSQL is licensed under the PostgreSQL License. pgvector is also licensed under the PostgreSQL License. Both run as separate database components and are not distributed in this package.

## Full license texts

The MIT License text for this project is in `LICENSE`.

The PostgreSQL License text is available at https://www.postgresql.org/about/licence/.

The Apache License 2.0 text is available at https://www.apache.org/licenses/LICENSE-2.0.

Full license texts for the runtime dependencies are included in `licenses/`:

- `licenses/zod-MIT.txt`
- `licenses/pg-boss-MIT.txt`
- `licenses/quickjs-emscripten-MIT.txt`
- `licenses/pg-PostgreSQL.txt`
- `licenses/opentelemetry-Apache-2.0.txt`
- `licenses/onnxruntime-MIT.txt`

The MIT License text for BGE-small-zh-v1.5 is included at `models/bge-small-zh-v1.5/LICENSE`.

---

# 第三方组件与许可声明（中文）

本仓库以 GPL-3.0-only 分发（见 `LICENSE`）。以下是随仓库分发或运行期依赖的第三方组件。

## 随仓库分发的模型文件

`models/bge-small-zh-v1.5/`：

- 来源：`BAAI/bge-small-zh-v1.5`（MIT）与 `onnx-community/bge-small-zh-v1.5-ONNX`（MIT）。
- 文件：`vocab.txt`、`model_quantized.onnx`、`model_quantized.onnx_data`。
- 修改：无；权重文件名不可改（ONNX 图内部引用外部数据文件名）。
- 体积约 24MB；缺失时嵌入通道标 `unavailable`，不伪造向量。

## 运行期依赖

| 包 | 许可 | 用途 |
| --- | --- | --- |
| `pg` | PostgreSQL License | PostgreSQL 客户端 |
| `pg-boss` | MIT | PostgreSQL 任务队列/调度 |
| `quickjs-emscripten` | MIT | 动态属性 JS 沙箱（WASM） |
| `@opentelemetry/api` | Apache-2.0 | pg-boss 的 peer 遥测接口 |
| `zod` | MIT | 工具输入 schema |
| `onnxruntime-node` | MIT | BGE 本地推理（optionalDependency） |
| PostgreSQL `vector` (pgvector) | PostgreSQL License | 向量列与 HNSW 索引（数据库扩展，不随本包分发） |
| `pg_trgm` | PostgreSQL License | ASCII 短模式/相似度（数据库扩展） |

`@opentelemetry/api` 为 Apache-2.0：保留其 `LICENSE`/`NOTICE` 与版权声明；本仓库未修改其源码。其余运行期依赖均为 MIT/PostgreSQL License，保留各自版权与许可文本即可。

## 开发/构建依赖

`esbuild`、`eslint`、`typescript`、`typescript-eslint`、`vitest`、`tsx`、`@types/*`：仅开发/测试期使用，不进入 v7 单文件产物。完整依赖树与许可见 `pnpm-lock.yaml`；可用 `pnpm licenses list` 生成逐包清单。

## 设计参考

v7 的选型与概念参考只保留在代码注释和发布说明中；当前代码没有复制 graphiti / mem0 / graphrag 的源码。若后续复制 Apache-2.0 代码，必须在本文件和发布说明中登记来源、版本、修改说明，并保留 `LICENSE`/`NOTICE`。
