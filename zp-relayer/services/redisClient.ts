import config from '@/configs/baseConfig'
import Redis from 'ioredis'

export const redis = new Redis(config.COMMON_REDIS_URL, {
  maxRetriesPerRequest: null,
})
