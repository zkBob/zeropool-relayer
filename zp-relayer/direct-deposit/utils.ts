import { logger } from '@/services/appLogger'
import { redis } from '@/services/redisClient'
import config from '@/configs/watcherConfig'
import type { DirectDeposit } from '@/queue/poolTxQueue'

const serviceKey = 'direct-deposit'
const lastBlockRedisKey = `${serviceKey}:lastProcessedBlock`

export let lastProcessedBlock = Math.max(config.startBlock - 1, 0)
export let lastReprocessedBlock: number

export async function getLastProcessedBlock() {
  const result = await redis.get(lastBlockRedisKey)
  logger.debug('Last Processed block obtained', { fromRedis: result, fromConfig: lastProcessedBlock })
  lastProcessedBlock = result ? parseInt(result, 10) : lastProcessedBlock
}

export function updateLastProcessedBlock(lastBlockNumber: number) {
  lastProcessedBlock = lastBlockNumber
  return redis.set(lastBlockRedisKey, lastProcessedBlock)
}

export function validateDirectDepositEvent(o: Object): o is DirectDeposit {
  for (const field in ['sender', 'nonce', 'fallbackUser', 'zkAddress', 'deposit']) {
    if (!(field in o)) {
      return false
    }
  }
  return true
}
