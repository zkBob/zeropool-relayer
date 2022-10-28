import type { Redis } from 'ioredis'

export class RootSet {
  constructor(public name: string, private redis: Redis) {}

  async add(roots: Record<number, string>) {
    if (Object.keys(roots).length === 0) return
    await this.redis.hset(this.name, roots)
  }

  async remove(indices: string[]) {
    if (indices.length === 0) return
    await this.redis.hdel(this.name, indices)
  }

  async get(index: string) {
    return this.redis.hget(this.name, index)
  }

  async clear() {
    await this.redis.del(this.name)
  }
}
