import { ProcessResult } from '@/pool/BasePool'
import { SendAttempt } from '@/services/network'
import { redis } from '@/services/redisClient'
import { SENT_TX_QUEUE_NAME } from '@/utils/constants'
import { Queue } from 'bullmq'

export interface SentTxPayload {
  poolJobId: string
  processResult: ProcessResult
  prevAttempts: SendAttempt<any>[]
}

export enum SentTxState {
  MINED = 'MINED',
  REVERT = 'REVERT',
  SKIPPED = 'SKIPPED',
}

export const sentTxQueue = new Queue<SentTxPayload>(SENT_TX_QUEUE_NAME, {
  connection: redis,
})
