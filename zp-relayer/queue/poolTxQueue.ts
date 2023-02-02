import { Queue } from 'bullmq'
import { TX_QUEUE_NAME } from '@/utils/constants'
import type { Proof } from 'libzkbob-rs-node'
import { TxType } from 'zp-memo-parser'
import { redis } from '@/services/redisClient'

export interface TxPayload {
  amount: string
  gas: string | number
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

export enum WorkerTxType {
  Normal = 'normal',
  DirectDeposit = 'dd',
}

export type WorkerTx<T extends WorkerTxType> = T extends WorkerTxType.Normal
  ? TxPayload
  : T extends WorkerTxType.DirectDeposit
  ? DirectDeposit[]
  : never

export interface BatchTx<T extends WorkerTxType> {
  type: T
  transactions: WorkerTx<T>[]
  traceId?: string
}

export type PoolTxResult = [string, string]

export const poolTxQueue = new Queue<BatchTx<WorkerTxType>, PoolTxResult[]>(TX_QUEUE_NAME, {
  connection: redis,
})
