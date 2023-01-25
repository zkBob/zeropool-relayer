export class BatchCache<T> {
  private cache: T[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(private batchSize: number, private ttl: number, private cb: (es: T[]) => void) {}

  private onTimerEnd() {
    if (this.cache.length > 0) {
      this.execute()
    }
  }

  private clearTimer() {
    if (this.timer) {
      clearInterval(this.timer)
    }
  }

  private setTimer() {
    this.clearTimer()
    this.timer = setInterval(() => this.onTimerEnd(), this.ttl)
  }

  private execute() {
    this.clearTimer()
    this.cb([...this.cache])
    this.cache = []
  }

  add(value: T) {
    this.cache.push(value)
    if (this.cache.length >= this.batchSize) {
      // Execute batch if it is full
      this.execute()
    } else if (this.cache.length === 1) {
      // Start timer if new batch was just created
      this.setTimer()
    }
  }
}
