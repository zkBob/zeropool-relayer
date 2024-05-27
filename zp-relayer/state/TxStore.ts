import type { Redis } from 'ioredis'

export class TxStore {
  constructor(public name: string, private redis: Redis) {}

  async add(index: number, memo: string) {
    await this.redis.hset(this.name, { [index]: memo })
  }

  async remove(index: string) {
    await this.redis.hdel(this.name, index)
  }

  async get(index: string) {
    const memo = await this.redis.hget(this.name, index)
    return memo
  }

  async getAll() {
    return await this.redis.hgetall(this.name)
  }
}