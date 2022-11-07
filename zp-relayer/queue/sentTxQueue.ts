import { Queue } from 'bullmq'
import { redis } from '@/services/redisClient'
import { SENT_TX_QUEUE_NAME } from '@/utils/constants'
import type { TransactionConfig } from 'web3-core'
import { GasPriceValue } from '@/services/gas-price'
import { TxData, TxType } from 'zp-memo-parser'

export interface SentTxPayload {
  txType: TxType
  root: string
  outCommit: string
  commitIndex: number
  txHash: string
  prefixedMemo: string
  txConfig: TransactionConfig
  nullifier: string
  gasPriceOptions: GasPriceValue
  txData: TxData
}

export enum SentTxState {
  MINED = 'MINED',
  REVERT = 'REVERT',
  RESEND = 'RESEND',
  FAILED = 'FAILED',
}

export type SentTxResult = [SentTxState, string]

export const sentTxQueue = new Queue<SentTxPayload, SentTxResult>(SENT_TX_QUEUE_NAME, {
  connection: redis,
})
