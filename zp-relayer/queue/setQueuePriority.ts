import { QueueEvents } from 'bullmq'
import { TX_QUEUE_NAME } from '@/utils/constants'
import { directDepositQueue } from './directDepositQueue'
import { redis } from '@/services/redisClient'

export default function setQueuePriority() {
  const events = new QueueEvents(TX_QUEUE_NAME, {
    connection: redis,
  })
  events.on('added', () => {
    directDepositQueue.pause()
  })
  events.on('drained', () => {
    directDepositQueue.resume()
  })
}
