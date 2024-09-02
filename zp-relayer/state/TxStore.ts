import type { Redis } from 'ioredis'

export class TxStore {
  constructor(public name: string, private redis: Redis) {}

  async add(commitment: string, memo: string) {
    await this.redis.hset(this.name, { [commitment]: memo })
  }

  async remove(commitment: string) {
    await this.redis.hdel(this.name, commitment)
  }

  async get(commitment: string) {
    const memo = await this.redis.hget(this.name, commitment)
    return memo
  }

  async getAll() {
    return await this.redis.hgetall(this.name)
  }

  async removeAll() {
    const allKeys = await this.getAll().then(res => Object.keys(res))
    await this.redis.hdel(this.name, ...allKeys)
  }
}