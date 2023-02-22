import { logger } from '@/services/appLogger'
import { redis } from '@/services/redisClient'
import config from '@/configs/baseConfig'
import type { DirectDeposit } from '@/queue/poolTxQueue'

const serviceKey = 'direct-deposit'
const lastBlockRedisKey = `${serviceKey}:lastProcessedBlock`

export let lastProcessedBlock = Math.max(config.startBlock - 1, 0)

export async function getLastProcessedBlock() {
  const result = await redis.get(lastBlockRedisKey)
  logger.debug('Last Processed block obtained', { fromRedis: result, fromConfig: lastProcessedBlock })
  lastProcessedBlock = result ? parseInt(result, 10) : lastProcessedBlock
}

export function updateLastProcessedBlock(lastBlockNumber: number) {
  lastProcessedBlock = lastBlockNumber
  return redis.set(lastBlockRedisKey, lastProcessedBlock)
}

export function parseDirectDepositEvent(o: Record<string, any>): DirectDeposit {
  const dd: DirectDeposit = {
    sender: o.sender,
    nonce: o.nonce,
    fallbackUser: o.fallbackUser,
    zkAddress: {
      diversifier: o.zkAddress.diversifier,
      pk: o.zkAddress.pk,
    },
    deposit: o.deposit,
  }

  return dd
}
