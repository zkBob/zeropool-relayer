import type { Redis } from 'ioredis'

export class JobIdsMapping {
  constructor(public name: string, private redis: Redis) {}

  async add(mapping: Record<string, string>) {
    if (Object.keys(mapping).length === 0) return
    await this.redis.hset(this.name, mapping)
  }

  async remove(indices: string[]) {
    if (indices.length === 0) return
    await this.redis.hdel(this.name, ...indices)
  }

  async get(id: string): Promise<string> {
    const mappedId = await this.redis.hget(this.name, id)
    if (mappedId) {
      return await this.get(mappedId)
    } else {
      return id
    }
  }

  async clear() {
    await this.redis.del(this.name)
  }
}
