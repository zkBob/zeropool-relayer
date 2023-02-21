import { Queue } from 'bullmq'
import { SENT_TX_QUEUE_NAME } from '@/utils/constants'
import { redis } from '@/services/redisClient'
import type { TransactionConfig } from 'web3-core'
import type { GasPriceValue } from '@/services/gas-price'
import type { BatchTx, WorkerTxType } from './poolTxQueue'

export type SendAttempt = [string, GasPriceValue]
export interface SentTxPayload {
  poolJobId: string
  root: string
  outCommit: string
  commitIndex: number
  truncatedMemo: string
  txConfig: TransactionConfig
  nullifier?: string
  txPayload: BatchTx<WorkerTxType, false>
  prevAttempts: SendAttempt[]
}

export enum SentTxState {
  MINED = 'MINED',
  REVERT = 'REVERT',
  SKIPPED = 'SKIPPED',
}

export type SentTxResult = [SentTxState, string, string[]]

export const sentTxQueue = new Queue<SentTxPayload, SentTxResult>(SENT_TX_QUEUE_NAME, {
  connection: redis,
})
