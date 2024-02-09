import type { DelegatedDepositBatchPub, DelegatedDepositBatchSec, Proof, TreePub, TreeSec } from 'libzkbob-rs-node'

// TODO: add support for DD
export enum Circuit {
  Tree = 'tree',
  DirectDeposit = 'direct-deposit',
}

type ProveInput<C extends Circuit> = C extends Circuit.Tree
  ? [TreePub, TreeSec]
  : C extends Circuit.DirectDeposit
  ? [DelegatedDepositBatchPub, DelegatedDepositBatchSec]
  : never

export type PubInput<T extends Circuit> = ProveInput<T> extends [infer P, any] ? P : never
export type SecInput<T extends Circuit> = ProveInput<T> extends [any, infer S] ? S : never

export interface IProver<C extends Circuit> {
  prove(pub: PubInput<C>, sec: SecInput<C>): Promise<Proof>
}
