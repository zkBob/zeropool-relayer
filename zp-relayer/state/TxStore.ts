import { hexToNumber, numberToHexPadded } from '@/utils/helpers';
import type { Redis } from 'ioredis'

const INDEX_BYTES = 6;

export class TxStore {
  constructor(public name: string, private redis: Redis) {}

  async add(commitment: string, memo: string, index: number) {
    await this.redis.hset(this.name, { [commitment]: `${numberToHexPadded(index, INDEX_BYTES)}${memo}` })
  }

  async remove(commitment: string) {
    await this.redis.hdel(this.name, commitment)
  }

  async get(commitment: string): Promise<{memo: string, index: number} | null> {
    const data = await this.redis.hget(this.name, commitment);

    return data ? { 
      memo: data.slice(INDEX_BYTES * 2),
      index: hexToNumber(data.slice(0, INDEX_BYTES * 2)),
    } : null;
  }

  async getAll(): Promise<Record<string, {memo: string, index: number}>> {
    return this.redis.hgetall(this.name).then(keys => Object.fromEntries(
      Object.entries(keys)
        .map(([commit, data]) => 
          [commit,
          { 
            memo: data.slice(INDEX_BYTES * 2),
            index: hexToNumber(data.slice(0, INDEX_BYTES * 2)),
          }] as [string, {memo: string, index: number}]
        )
      ));
  }

  async removeAll() {
    const allKeys = await this.getAll().then(res => Object.keys(res))
    await this.redis.hdel(this.name, ...allKeys)
  }
}