import type Redis from 'ioredis'
import { Mutex } from 'async-mutex'
import { logger } from '@/services/appLogger'
import {
  DIRECT_DEPOSIT_REPROCESS_INTERVAL,
  DIRECT_DEPOSIT_REPROCESS_NAME,
  DIRECT_DEPOSIT_SET_NAME,
} from '@/utils/constants'

export class BatchCache<T extends { nonce: string }> {
  private timer: NodeJS.Timeout | null = null
  private mutex = new Mutex()

  constructor(
    private batchSize: number,
    private ttl: number,
    private cb: (es: T[]) => Promise<void> | void,
    private validate: (e: T) => Promise<void>,
    private redis: Redis,
    private key: string = DIRECT_DEPOSIT_SET_NAME
  ) {}

  async init() {
    await this.processCache()
    this.watchReprocess()
  }

  private watchReprocess() {
    setInterval(async () => {
      const rawEs = await this.redis.lpop(DIRECT_DEPOSIT_REPROCESS_NAME, this.batchSize)
      if (!rawEs || rawEs.length === 0) {
        return
      }
      const es: [string, T][] = rawEs.map(rawE => {
        const e = JSON.parse(rawE)
        return [e.nonce, e]
      })
      await this.add(es)
    }, DIRECT_DEPOSIT_REPROCESS_INTERVAL)
  }

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

    if (validatedEs.length === 0) {
      logger.warn('Empty batch after validation, skipping')
      return
    }
    await this.cb(validatedEs)
  }

  private async processCache() {
    let count = await this.count()

    if (count < this.batchSize) {
      // Check if we started a new batch
      if (this.timer === null) {
        this.setTimer()
      }
      return
    }

    // Execute all whole batches
    while (count >= this.batchSize) {
      await this.execute()
      count = await this.count()
    }

    // If batch still has less than `batchSize`
    // elements then update a timer
    if (count % this.batchSize != 0) {
      this.setTimer()
    }
  }

  // TODO: could be optimized
  // We don't need to insert `values` in db if `count` + `values.length` > `batchSize`
  // This implementation is simpler and doesn't have any tricky edge cases
  async add(values: [string, T][]) {
    if (values.length === 0) {
      return
    }

    // Prevents possible race condition between
    // `watchReprocess` and explicit `add` call
    const release = await this.mutex.acquire()

    try {
      await this.addToRedis(values)
      await this.processCache()
    } finally {
      release()
    }
  }
}
