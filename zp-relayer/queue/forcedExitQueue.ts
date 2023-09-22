import { Queue } from 'bullmq'
import { FORCED_EXIT_QUEUE_NAME } from '@/utils/constants'
import { redis } from '@/services/redisClient'

export interface ForcedExitPayload {
  nullifier: string
}

export const forcedExitQueue = new Queue<ForcedExitPayload>(FORCED_EXIT_QUEUE_NAME, {
  connection: redis,
})
