import { Queue } from 'bullmq'
import { redis } from '@/services/redisClient'
import { SENT_TX_QUEUE_NAME } from '@/utils/constants'
import type { TransactionConfig } from 'web3-core'
import type { GasPriceValue } from '@/services/gas-price'
import type { TxPayload } from './poolTxQueue'
import type { DirectDeposit } from './directDepositQueue'

export type SendAttempt = [string, GasPriceValue]
export interface SentTxPayload {
  poolJobId: string
  root: string
  outCommit: string
  commitIndex: number
  truncatedMemo: string
  txConfig: TransactionConfig
  nullifier?: string
  txPayload: TxPayload | DirectDeposit[]
  prevAttempts: SendAttempt[]
  traceId?: string
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
