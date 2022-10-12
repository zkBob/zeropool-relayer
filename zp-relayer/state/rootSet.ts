import { redis } from '@/services/redisClient'

export class RootSet {
  constructor(public name: string) {}

  async add(roots: Record<number, string>) {
    if (Object.keys(roots).length === 0) return
    await redis.hset(this.name, roots)
  }

  async remove(indices: string[]) {
    if (indices.length === 0) return
    await redis.hdel(this.name, indices)
  }

  async get(index: string) {
    return redis.hget(this.name, index)
  }

  async clear() {
    await redis.del(this.name)
  }
}
