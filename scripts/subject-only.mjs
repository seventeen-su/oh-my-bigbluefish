/**
 * `git filter-branch --msg-filter` 用的过滤器：**只保留标题行，丢弃正文**。
 *
 * 与 `msg-filter.mjs` 的分工：那个负责把标题压成简练单行（历史已跑过一轮）；
 * 这个负责清掉"漏网的正文"——正文只会在标题被改写、正文原样保留的情形下残留
 * （实测漏了一条：改写发生在它创建之前，后来它又被 rebase 带回历史）。
 *
 * 用法与 `msg-filter.mjs` 一样由 `git filter-branch` 从 stdin 读、向 stdout 写。
 */
import { readFileSync } from 'node:fs'

const subject = (readFileSync(0, 'utf8').split('\n')[0] ?? '').trim()
process.stdout.write(subject)
