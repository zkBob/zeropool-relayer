import { redis } from '../services/redisClient'

export class NullifierSet {
  constructor(public name: string) {}

  async add(nullifiers: string[]) {
    if (nullifiers.length === 0) return
    await redis.sadd(this.name, nullifiers)
  }

  async remove(nullifiers: string[]) {
    if (nullifiers.length === 0) return
    await redis.srem(this.name, nullifiers)
  }

  async isInSet(nullifier: string) {
    return await redis.sismember(this.name, nullifier)
  }

  async clear() {
    await redis.del(this.name)
  }
}
