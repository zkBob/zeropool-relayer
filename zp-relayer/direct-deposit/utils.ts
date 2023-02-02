import { logger } from '@/services/appLogger'
import { redis } from '@/services/redisClient'
import type { DirectDeposit } from '@/queue/poolTxQueue'

const serviceKey = 'direct-deposit'
const lastNonceRedisKey = `${serviceKey}:lastProcessedNonce`

export let lastProcessedNonce = 0

export async function getLastProcessedNonce() {
  const result = await redis.get(lastNonceRedisKey)
  logger.debug('Last Processed nonce obtained', { fromRedis: result, fromConfig: lastProcessedNonce })
  lastProcessedNonce = result ? parseInt(result, 10) : lastProcessedNonce
}

export function updateLastProcessedNonce(lastNonce: number) {
  lastProcessedNonce = lastNonce
  return redis.set(lastNonceRedisKey, lastProcessedNonce)
}

export function validateDirectDepositEvent(o: Object): o is DirectDeposit {
  for (const field in ['sender', 'nonce', 'fallbackUser', 'zkAddress', 'deposit']) {
    if (!(field in o)) {
      return false
    }
  }
  return true
}
