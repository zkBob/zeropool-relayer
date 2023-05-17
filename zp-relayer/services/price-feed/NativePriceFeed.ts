import type BN from 'bn.js'
import type { IPriceFeed } from './IPriceFeed'

export class NativePriceFeed implements IPriceFeed {
  constructor() {}

  async convert(baseTokenAmounts: BN[]): Promise<BN[]> {
    return baseTokenAmounts
  }
}
