import { Queue } from 'bullmq'
import { TX_QUEUE_NAME } from '@/utils/constants'
import type { Proof } from 'libzkbob-rs-node'
import type { TxType } from 'zp-memo-parser'
import { redis } from '@/services/redisClient'

export enum JobState {
  WAITING = 'waiting',
  SENT = 'sent',
  COMPLETED = 'completed',
  REVERTED = 'reverted',
  FAILED = 'failed',
}

export interface BaseTxPayload {
  txProof: Proof
  txHash: string | null
  state: JobState
}

export interface TxPayload extends BaseTxPayload {
  amount: string
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

export interface DirectDepositTxPayload extends BaseTxPayload {
  deposits: DirectDeposit[]
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

export interface PoolTx<T extends WorkerTxType> {
  type: T
  transaction: WorkerTx<T>
  traceId?: string
}

export const poolTxQueue = new Queue<PoolTx<WorkerTxType>>(TX_QUEUE_NAME, {
  connection: redis,
})
