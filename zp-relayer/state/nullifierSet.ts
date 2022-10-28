import type { Redis } from 'ioredis'
export class NullifierSet {
  constructor(public name: string, private redis: Redis) {}

  async add(nullifiers: string[]) {
    if (nullifiers.length === 0) return
    await this.redis.sadd(this.name, nullifiers)
  }

  async remove(nullifiers: string[]) {
    if (nullifiers.length === 0) return
    await this.redis.srem(this.name, nullifiers)
  }

  async isInSet(nullifier: string) {
    return await this.redis.sismember(this.name, nullifier)
  }

  async clear() {
    await this.redis.del(this.name)
  }
}
