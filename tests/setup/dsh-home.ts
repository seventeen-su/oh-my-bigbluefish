/**
 * 测试隔离：把 `$DSH_HOME` 指到**本次运行的临时目录**。
 *
 * ## 为什么必须有这个 setup
 *
 * `dsh/stores.ts:91` 在拿不到注入端口时会按 `$DSH_HOME` → `~/.dsh` 解析，
 * 而隐私状态文件（`<dshHome>/.omb/privacy/session-modes.json`）与用户库
 * （`<dshHome>/.omb/memory/knowledge.db`）都挂在这条路径下。于是少数用例
 * （装配冒烟、`tests/modules/memory/registration.test.ts` 的几处、`status-honesty`
 * 的一处）会去读**开发者真实**的 `~/.dsh/...`——这是隔离性缺陷，两次实测都被点名：
 *
 * - `tests/modules/privacy/module.test.ts:81` 的注释；
 * - 2026-10-06 隐私并入流的回报 §5.2（"未修：真正的修法是给 vitest 加 setup"）。
 *
 * 后果不是"读到一点脏数据"这么轻：真机那份状态文件一旦是 fail-closed 粘性
 * （`sealed` 或损坏），这些用例会看到"全局禁写"而**无故变红**——
 * 一次与代码无关的红，会把真正的回归淹掉。
 *
 * ## 为什么是环境变量而不是别的
 *
 * 路径解析链是"显式配置 → 宿主端口 → `$DSH_HOME` → `~/.dsh`"（`modules/memory/paths.ts:27-42`、
 * `modules/memory/privacy/durable.ts:23-24`）：注入端口的用例本来就隔离，
 * 剩下会漏到真实 home 的只有"完全不给端口"的那几处——**设置环境变量正好覆盖它们**。
 *
 * 想跑真实目录（例如排查"真机状态文件损坏会不会影响测试"）时设
 * `OMB_TEST_KEEP_DSH_HOME=1` 即可跳过覆盖。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env['OMB_TEST_KEEP_DSH_HOME'] !== '1') {
  process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'omb-test-dsh-'))
}
