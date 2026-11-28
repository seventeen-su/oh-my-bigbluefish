# Third-Party Notices

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
