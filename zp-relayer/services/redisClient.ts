import Redis from 'ioredis'

export let redis: Redis

export function initRedis(url: string) {
  redis = new Redis(url, {
    maxRetriesPerRequest: null,
  })
}
