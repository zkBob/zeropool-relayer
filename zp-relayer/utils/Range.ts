type BoundedRange = [number, number]

interface RangeParams {
  start: number
  end: number
  step: number
}

export class Range implements Iterable<BoundedRange> {
  constructor(private readonly params: RangeParams) {}
  [Symbol.iterator](): Iterator<BoundedRange, any, undefined> {
    return new RangeIterator(this.params)
  }
}

class RangeIterator implements Iterator<BoundedRange> {
  private order: number
  private curRangeStart: number
  constructor(private readonly params: RangeParams) {
    this.order = params.step > 0 ? 1 : -1
    this.curRangeStart = params.start
  }
  next(): IteratorResult<BoundedRange> {
    if ((this.curRangeStart - this.params.end) * this.order > 0) {
      return {
        value: undefined,
        done: true,
      }
    }

    let curRangeEnd = this.curRangeStart + this.params.step
    // Update range end we reach out of bounds
    if ((this.params.end - curRangeEnd) * this.order <= 0) {
      curRangeEnd = this.params.end
    }

    const res = {
      value: [this.curRangeStart, curRangeEnd] as BoundedRange,
      done: false,
    }

    this.curRangeStart = curRangeEnd + this.order
    return res
  }
}
