import { SendAttempt } from '@/lib/network'
import { redis } from '@/lib/redisClient'
import { ProcessResult } from '@/pool/types'
import { SENT_TX_QUEUE_NAME } from '@/utils/constants'
import { Queue } from 'bullmq'

export interface SentTxPayload {
  poolJobId: string
  processResult: ProcessResult<any>
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
