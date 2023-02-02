import { logger } from '@/services/appLogger'
import type Redis from 'ioredis'

export class BatchCache<T> {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private batchSize: number,
    private ttl: number,
    private cb: (es: T[]) => Promise<void> | void,
    private validate: (e: T) => Promise<void>,
    private redis: Redis,
    private key: string = 'dd:cache'
  ) {}

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private setTimer() {
    this.clearTimer()
    this.timer = setTimeout(() => this.execute(), this.ttl)
  }

  private addToRedis(values: [string, T][]) {
    const rawValues = values.map(([s, v]) => [s, JSON.stringify(v)])
    return this.redis.zadd(this.key, ...rawValues.flat())
  }

  private async take(count: number) {
    if (count === 0) return []
    const es: string[] = await this.redis.zpopmin(this.key, count)
    // Remove score values and parse JSON
    let res: T[] = []
    for (let i = 0; i < es.length; i += 2) {
      res.push(JSON.parse(es[i]))
    }

    return res
  }

  // TODO: count could be maintained in-memory
  private count() {
    return this.redis.zcard(this.key)
  }

  private async execute() {
    this.clearTimer()
    const validatedEs: T[] = []
    let es: T[] = []
    let count: number
    do {
      count = this.batchSize - validatedEs.length
      es = await this.take(count)

      const validatedResults = await Promise.allSettled(
        es.map(async e => {
          try {
            await this.validate(e)
            return e
          } catch (err) {
            logger.error('Validation failed', {
              error: (err as Error).message,
              elem: e,
            })
            throw err
          }
        })
      )

      for (const r of validatedResults) {
        if (r.status === 'fulfilled') {
          validatedEs.push(r.value)
        }
      }
    } while (validatedEs.length < this.batchSize && count === es.length)
    // validatedEs.length === batchSize  => batch is full
    //              count  <  es.length  => cache is drained

    if (es.length === 0) {
      return
    }
    await this.cb(es)
  }

  // TODO: could be optimized
  // We don't need to insert `values` in db if `count` + `values.length` > `batchSize`
  // This implementation is simpler and doesn't have any tricky edge cases
  async add(values: [string, T][]) {
    if (values.length === 0) {
      return
    }

    await this.addToRedis(values)
    const count = await this.count()

    // Execute all whole batches
    if (count >= this.batchSize) {
      do {
        await this.execute()
      } while ((await this.count()) >= this.batchSize)
    }

    // If we created a new batch or overflowed
    // previous one then start a timer
    if (count % this.batchSize != 0) {
      this.setTimer()
    }
  }
}
