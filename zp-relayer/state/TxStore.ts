import { hexToNumber, numberToHexPadded } from '@/utils/helpers';
import type { Redis } from 'ioredis'

const TIMESTAMP_BYTES = 6; // enough for another ~8000 years

export class TxStore {
  constructor(public name: string, private redis: Redis) {}

  async add(commitment: string, memo: string, timestamp: number) {
    await this.redis.hset(this.name, { [commitment]: `${numberToHexPadded(timestamp, TIMESTAMP_BYTES)}${memo}` })
  }

  async remove(commitment: string) {
    await this.redis.hdel(this.name, commitment)
  }

  async get(commitment: string): Promise<{memo: string, timestamp: number} | null> {
    const data = await this.redis.hget(this.name, commitment);

    return data ? { 
      memo: data.slice(TIMESTAMP_BYTES * 2),
      timestamp: hexToNumber(data.slice(0, TIMESTAMP_BYTES * 2)),
    } : null;
  }

  async getAll(): Promise<Record<string, {memo: string, timestamp: number}>> {
    return this.redis.hgetall(this.name).then(keys => Object.fromEntries(
      Object.entries(keys)
        .map(([commit, data]) => 
          [commit,
          { 
            memo: data.slice(TIMESTAMP_BYTES * 2),
            timestamp: hexToNumber(data.slice(0, TIMESTAMP_BYTES * 2)),
          }] as [string, {memo: string, timestamp: number}]
        )
      ));
  }

  async removeAll() {
    const allKeys = await this.getAll().then(res => Object.keys(res))
    await this.redis.hdel(this.name, ...allKeys)
  }
}