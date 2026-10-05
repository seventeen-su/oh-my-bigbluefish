/**
 * `git filter-branch --msg-filter` 用的过滤器：把提交信息压成简练单行。
 *
 * ⚠ **历史工具：不在任何链上，重跑会改写历史。**
 * 它已经跑过一轮，现在只作为"那次改写是怎么做的"的存档留着：
 * 没有任何 `package.json` script 或测试引用它，日常开发不需要它；
 * 再跑一次会**重写整段历史**（哈希全变），只有在明确要重做那次改写时才动。
 * 提交信息纪律见 `docs/parallel-work.md`。
 *
 * 从 stdin 读原始信息（首行是标题、其余是正文），向 stdout 写新信息。
 * 正文一并丢弃——目标形态就是"简练单行"，留着几百字的正文与目标相反。
 *
 * 单独成文件（而不是内联 `node -e`）：`--msg-filter` 每条提交都会 spawn 一次，
 * 内联脚本的引号转义在 Windows 上极易出错。
 */
import { readFileSync } from 'node:fs'
import { condense } from './condense-messages.mjs'

const raw = readFileSync(0, 'utf8')
const subject = raw.split('\n')[0] ?? ''
const next = condense(subject)
process.stdout.write(next === '' ? subject.trim() : next)
