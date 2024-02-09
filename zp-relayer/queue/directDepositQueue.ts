import { redis } from '@/services/redisClient'
import { DIRECT_DEPOSIT_QUEUE_NAME } from '@/utils/constants'
import { Queue } from 'bullmq'
import { DirectDeposit } from './poolTxQueue'

export const directDepositQueue = new Queue<DirectDeposit[], [string, string]>(DIRECT_DEPOSIT_QUEUE_NAME, {
  connection: redis,
})
