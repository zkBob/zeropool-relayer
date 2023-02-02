import type Redis from 'ioredis'

export class BatchCache<T> {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private batchSize: number,
    private ttl: number,
    private cb: (es: T[]) => Promise<void> | void,
    private redis: Redis,
    private key: string = 'dd:cache'
  ) {}

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer)
    }
  }

  private setTimer() {
    this.clearTimer()
    this.timer = setTimeout(() => this.execute(), this.ttl)
  }

  private addToRedis(values: [number, T][]) {
    const rawValues = values.map(([s, v]) => [s, JSON.stringify(v)] as [number, string])
    return this.redis.zadd(this.key, ...rawValues.flat())
  }

  private async take(count: number) {
    const es: string[] = await this.redis.zpopmin(this.key, count)
    return es.map(e => JSON.parse(e))
  }

  // TODO: count could be maintained in-memory
  private count() {
    return this.redis.zcard(this.key)
  }

  private async execute() {
    this.clearTimer()
    const es = await this.take(this.batchSize)
    if (es.length == 0) return
    await this.cb(es)
  }

  // TODO: could be optimized
  // We don't need to insert `values` in db if `count` + `values.length` > `batchSize`
  // This implementation is simpler and doesn't have any tricky edge cases
  async add(values: [number, T][]) {
    if (values.length === 0) {
      return
    }

    await this.addToRedis(values)
    const len = await this.count()
    const numBatches = Math.floor(len / this.batchSize)

    // Execute all whole batches
    for (let i = 0; i < numBatches; i++) {
      await this.execute()
    }

    // If we created a new batch or overflowed
    // previous one then start a timer
    if (len % this.batchSize != 0) {
      this.setTimer()
    }
  }
}
