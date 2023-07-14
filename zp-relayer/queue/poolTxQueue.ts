import { Queue } from 'bullmq'
import { TX_QUEUE_NAME } from '@/utils/constants'
import type { Proof } from 'libzkbob-rs-node'
import type { TxType } from 'zp-memo-parser'
import { redis } from '@/services/redisClient'

export interface TxPayload {
  amount: string
  txProof: Proof
  txType: TxType
  rawMemo: string
  depositSignature: string | null
}

interface ZkAddress {
  diversifier: string
  pk: string
}

export interface DirectDeposit {
  sender: string
  nonce: string
  fallbackUser: string
  zkAddress: ZkAddress
  deposit: string
}

export interface DirectDepositTxPayload {
  deposits: DirectDeposit[]
  txProof: Proof
  outCommit: string
  memo: string
}

export enum WorkerTxType {
  Normal = 'normal',
  DirectDeposit = 'dd',
}

export const WorkerTxTypePriority: Record<WorkerTxType, number> = {
  [WorkerTxType.Normal]: 1,
  [WorkerTxType.DirectDeposit]: 2,
}

export type WorkerTx<T extends WorkerTxType> = T extends WorkerTxType.Normal
  ? TxPayload
  : T extends WorkerTxType.DirectDeposit
  ? DirectDepositTxPayload
  : never

export interface BatchTx<T extends WorkerTxType, M extends boolean = true> {
  type: T
  transactions: M extends true ? WorkerTx<T>[] : WorkerTx<T>
  traceId?: string
}

export type PoolTxResult = [string, string]

export const poolTxQueue = new Queue<BatchTx<WorkerTxType>, PoolTxResult[]>(TX_QUEUE_NAME, {
  connection: redis,
})
