import Redis from 'ioredis'
import config from '@/configs/baseConfig'

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
})
