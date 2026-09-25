/**
 * 画像测试用的假件。**不 mock 宿主**：画像只依赖内核 ABI 的窄端口，
 * 所以一个内存假库就够了（规划 §11.1：modules 层零宿主 mock）。
 */
import type { MemoryRecord, MemoryScope } from '../../../kernel/abi/index.js'

export class FakeStore {
  readonly records = new Map<string, MemoryRecord>()
  /** 每次 `put` 都记一笔——"写入次数为 0"这类断言靠它。 */
  readonly putCalls: MemoryRecord[] = []
  readonly getCalls: string[] = []
  failPut: string | null = null
  failGet: string | null = null

  async put(record: MemoryRecord): Promise<void> {
    this.putCalls.push(record)
    if (this.failPut !== null) throw new Error(this.failPut)
    this.records.set(record.id, record)
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    this.getCalls.push(id)
    if (this.failGet !== null) throw new Error(this.failGet)
    return this.records.get(id)
  }
}

/** 双库假件：结构上满足 `ProfileStoresPort`（也是真实 `StoreSet` 的形状子集）。 */
export class FakeStores {
  readonly user = new FakeStore()
  readonly project = new FakeStore()
  projectScope: string | null = 'D:/proj'

  store(scope: MemoryScope): FakeStore {
    return scope === 'user' ? this.user : this.project
  }

  get puts(): number {
    return this.user.putCalls.length + this.project.putCalls.length
  }

  get putRecords(): readonly MemoryRecord[] {
    return [...this.user.putCalls, ...this.project.putCalls]
  }
}

export function fakeClock(start = 1_000_000): {
  now(): number
  advance(ms: number): void
  set(value: number): void
} {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
    set: (value: number) => {
      now = value
    },
  }
}
