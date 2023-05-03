import type BN from 'bn.js'
import type { IPriceFeed } from './IPriceFeed'
import { toBN } from 'web3-utils'

export class NativePriceFeed implements IPriceFeed {
  constructor() {}

  async convert(baseTokenAmounts: BN[]): Promise<BN[]> {
    return baseTokenAmounts.map(() => toBN(1))
  }
}
