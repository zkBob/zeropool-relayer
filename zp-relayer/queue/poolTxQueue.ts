import { Queue } from 'bullmq'
import { redis } from '../services/redisClient'
import { TX_QUEUE_NAME } from '../utils/constants'
import { Proof } from 'libzkbob-rs-node'
import { TxType } from 'zp-memo-parser'

export interface TxPayload {
  amount: string
  gas: string | number
  txProof: Proof
  txType: TxType
  rawMemo: string
  depositSignature: string | null
}
export const poolTxQueue = new Queue<TxPayload[], string>(TX_QUEUE_NAME, {
  connection: redis,
})
