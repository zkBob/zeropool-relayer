import { Queue } from 'bullmq'
import { redis } from '@/services/redisClient'
import { SENT_TX_QUEUE_NAME } from '@/utils/constants'
import type { TransactionConfig } from 'web3-core'
import { GasPriceValue } from '@/services/gas-price'
import { TxPayload } from './poolTxQueue'

export type SendAttempt = [string, GasPriceValue]
export interface SentTxPayload {
  poolJobId: string
  root: string
  outCommit: string
  commitIndex: number
  prefixedMemo: string
  txConfig: TransactionConfig
  nullifier: string
  txPayload: TxPayload
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
