export interface Link {
  readonly id: string
  readonly fromId: string
  readonly toId: string
  readonly relation: string
  readonly directed: boolean
  readonly strength: number
  readonly source: string
  readonly origin: string
  readonly createdAt: string
  readonly archivedAt?: string
}

export interface LinkInput {
  readonly fromId: string
  readonly toId: string
  readonly relation: string
  readonly directed?: boolean
  readonly strength?: number
  readonly source?: string
  readonly origin?: string
  readonly allowArchived?: boolean
}

export interface Expansion {
  readonly entityId: string
  readonly hop: number
  readonly score: number
  readonly viaLinkId: string
  readonly fromId: string
  readonly relation: string
  readonly chainId?: string
  /** 思维链成员在链内的位置；普通链接扩展没有该字段。 */
  readonly chainPosition?: number
}
