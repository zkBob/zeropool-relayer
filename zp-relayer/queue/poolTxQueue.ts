import { redis } from '@/services/redisClient'
import { TX_QUEUE_NAME } from '@/utils/constants'
import { Queue } from 'bullmq'
import type { Proof } from 'libzkbob-rs-node'
import type { TxType } from 'zp-memo-parser'

export enum JobState {
  WAITING = 'waiting',
  SENT = 'sent',
  COMPLETED = 'completed',
  REVERTED = 'reverted',
  FAILED = 'failed',
}

export interface BasePayload {
  txHash: string | null
  state: JobState
}

export interface BasePoolTx {
  proof: Proof
  memo: string
  txType: TxType
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

export interface DirectDepositTx {
  txProof: Proof
  deposits: DirectDeposit[]
  outCommit: string
  memo: string
}

export interface FinalizeTx {
  outCommit: string
  privilegedProver: string
  fee: string
  timestamp: string
  gracePeriodEnd: string
}

export interface TxPayload extends BasePayload, BasePoolTx {}
export interface DirectDepositTxPayload extends BasePayload, DirectDepositTx {}
export interface FinalizeTxPayload extends BasePayload, FinalizeTx {}

export enum WorkerTxType {
  Normal = 'normal',
  DirectDeposit = 'dd',
  Finalize = 'finalize',
}

export const WorkerTxTypePriority: Record<WorkerTxType, number> = {
  [WorkerTxType.Normal]: 1,
  [WorkerTxType.DirectDeposit]: 2,
  [WorkerTxType.Finalize]: 3, // TODO
}

export type WorkerTx<T extends WorkerTxType> = T extends WorkerTxType.Normal
  ? TxPayload
  : T extends WorkerTxType.DirectDeposit
  ? DirectDepositTxPayload
  : T extends WorkerTxType.Finalize
  ? FinalizeTxPayload
  : never

export interface PoolTx<T extends WorkerTxType> {
  type: T
  transaction: WorkerTx<T>
  traceId?: string
}

export const poolTxQueue = new Queue<PoolTx<WorkerTxType>>(TX_QUEUE_NAME, {
  connection: redis,
})
