import { migrateDatabase, truncateAll } from '../../../packages/v7/src/adapters/postgres/migrate.js'
import { PostgresStore } from '../../../packages/v7/src/adapters/postgres/store.js'
import { deriveSearchText, deriveTriggers, normalizeWrite } from '../../../packages/v7/src/domain/validation.js'
import type { WriteEntityInput } from '../../../packages/v7/src/domain/entity.js'
import type { DerivedWrite } from '../../../packages/v7/src/ports/store.js'

export const TEST_DATABASE_URL = process.env.OMB_TEST_DATABASE_URL ?? 'postgres://omb:omb@127.0.0.1:5432/omb_v7_test'

export async function prepareDatabase(): Promise<void> {
  await migrateDatabase(TEST_DATABASE_URL)
  await truncateAll(TEST_DATABASE_URL)
}

export async function resetDatabase(): Promise<void> {
  await truncateAll(TEST_DATABASE_URL)
}

export function store(): PostgresStore {
  return new PostgresStore(TEST_DATABASE_URL)
}

export function normalized(input: WriteEntityInput) {
  const result = normalizeWrite(input)
  if (!result.ok) throw new Error(`测试输入非法：${JSON.stringify(result.errors)}`)
  return result.value
}

export function derived(input: WriteEntityInput): DerivedWrite {
  const value = normalized(input)
  return {
    searchText: deriveSearchText(value.attributes),
    triggers: deriveTriggers(value.attributes),
  }
}
