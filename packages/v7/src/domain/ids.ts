export const ID_PREFIX = {
  memory: 'mem',
  state: 'st',
  stateVersion: 'sv',
  chain: 'ch',
  link: 'lnk',
  trace: 'trc',
  artifact: 'art',
} as const

export type IdKind = keyof typeof ID_PREFIX

const ID_PATTERN = /^(mem|st|sv|ch|lnk|trc|art)_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${crypto.randomUUID()}`
}

export function isId(value: string): boolean {
  return ID_PATTERN.test(value)
}

export function assertId(value: string, field = 'id'): string {
  if (!isId(value)) throw new Error(`${field} 不是合法的 OMB id：${value}`)
  return value
}
