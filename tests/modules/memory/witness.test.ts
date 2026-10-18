/**
 * 3.7-M4：`SessionWitnessPort` 的契约与惰性解析。
 *
 * 记忆模块**只读**这个端口；拿不到/畸形/抛异常一律当"没有见证"（退化到旧行为），
 * 绝不因为一个只读端口把写入路径拖垮。
 */
import { describe, expect, it } from 'vitest'
import { SERVICES } from '../../../kernel/abi/index.js'
import {
  SESSION_WITNESS_SERVICE,
  readSessionWitness,
  type SessionWitnessPort,
} from '../../../modules/memory/witness.js'

const valid: SessionWitnessPort = {
  lastUserMessage: () => '用户原话',
  hasExecution: () => true,
  surfaceGeneration: () => 3,
}

describe('SessionWitnessPort（3.7-M4）', () => {
  it('服务名来自目录唯一真源：SERVICES.sessionWitness', () => {
    expect(SESSION_WITNESS_SERVICE).toBe('omb:session-witness')
    expect(SESSION_WITNESS_SERVICE).toBe(SERVICES.sessionWitness)
  })

  it('正常解析：返回同一个对象', () => {
    const witness = readSessionWitness(name => (name === SESSION_WITNESS_SERVICE ? valid : undefined))
    expect(witness).toBe(valid)
    expect(witness?.lastUserMessage('s1')).toBe('用户原话')
    expect(witness?.hasExecution('s1', 'x')).toBe(true)
  })

  it('缺失 / 畸形 / 抛异常 → undefined（降级而不是崩）', () => {
    expect(readSessionWitness(undefined)).toBeUndefined()
    expect(readSessionWitness(() => undefined)).toBeUndefined()
    expect(readSessionWitness(() => null)).toBeUndefined()
    expect(readSessionWitness(() => '字符串')).toBeUndefined()
    expect(readSessionWitness(() => ({ lastUserMessage: 1 }))).toBeUndefined()
    expect(
      readSessionWitness(() => {
        throw new Error('服务表被清空')
      }),
    ).toBeUndefined()
  })
})
