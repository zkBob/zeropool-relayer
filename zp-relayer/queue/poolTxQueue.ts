import { Queue } from 'bullmq'
import { redis } from '@/services/redisClient'
import { TX_QUEUE_NAME } from '@/utils/constants'
import type { Proof } from 'libzkbob-rs-node'
import { TxType } from 'zp-memo-parser'

export interface TxPayload {
  amount: string
  gas: string | number
  txProof: Proof
  txType: TxType
  rawMemo: string
  depositSignature: string | null
}

export interface BatchTx {
  transactions: TxPayload[]
  traceId?: string
}

export type PoolTxResult = [string, string]

export const poolTxQueue = new Queue<BatchTx, PoolTxResult[]>(TX_QUEUE_NAME, {
  connection: redis,
})
