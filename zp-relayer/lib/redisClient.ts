import Redis from 'ioredis'

export const redis = new Redis(process.env.COMMON_REDIS_URL as string, {
  maxRetriesPerRequest: null,
})
