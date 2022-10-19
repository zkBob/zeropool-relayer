import { Queue, QueueScheduler } from 'bullmq'
import { redis } from '@/services/redisClient'
import { SENT_TX_QUEUE_NAME } from '@/utils/constants'
import type { TransactionConfig } from 'web3-core'
import { GasPriceValue } from '@/services/gas-price'

export interface SentTxPayload {
  root: string
  outCommit: string
  commitIndex: number
  txHash: string
  txData: string
  txConfig: TransactionConfig
  nullifier: string
  gasPriceOptions: GasPriceValue
}

export enum SentTxState {
  MINED = 'MINED',
  REVERT = 'REVERT',
  RESEND = 'RESEND',
  FAILED = 'FAILED',
}

export type SentTxResult = [SentTxState, string]

// Required for delayed jobs processing
const sentTxQueueScheduler = new QueueScheduler(SENT_TX_QUEUE_NAME, {
  connection: redis,
})

export const sentTxQueue = new Queue<SentTxPayload, SentTxResult>(SENT_TX_QUEUE_NAME, {
  connection: redis,
})
