import { Queue } from 'bullmq'
import { redis } from '@/services/redisClient'
import { SENT_TX_QUEUE_NAME } from '@/utils/constants'
import type { TransactionConfig } from 'web3-core'
import { GasPriceValue } from '@/services/gas-price'
import { TxPayload } from './poolTxQueue'

export interface SentTxPayload {
  root: string
  outCommit: string
  commitIndex: number
  txHash: string
  prefixedMemo: string
  txConfig: TransactionConfig
  nullifier: string
  gasPriceOptions: GasPriceValue
  txPayload: TxPayload
}

export enum SentTxState {
  MINED = 'MINED',
  REVERT = 'REVERT',
}

export type SentTxResult = [SentTxState, string, string[]]

export const sentTxQueue = new Queue<SentTxPayload, SentTxResult>(SENT_TX_QUEUE_NAME, {
  connection: redis,
})
