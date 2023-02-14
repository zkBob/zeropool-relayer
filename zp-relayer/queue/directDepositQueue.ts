import { Queue } from 'bullmq'
import { DIRECT_DEPOSIT_QUEUE_NAME } from '@/utils/constants'
import { DirectDeposit } from './poolTxQueue'
import { redis } from '@/services/redisClient'

export const directDepositQueue = new Queue<DirectDeposit[], [string, string]>(DIRECT_DEPOSIT_QUEUE_NAME, {
  connection: redis,
})
