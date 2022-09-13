import Redis from 'ioredis'
import { logger } from './appLogger'
import config from '@/config'

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
})

redis.on('connect', () => {
  logger.info('Connected to redis')
})

redis.on('error', () => {
  logger.error('Disconnected from redis')
})
