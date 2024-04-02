import type BN from 'bn.js'
import { toBN } from 'web3-utils'
import type { IPriceFeed } from './IPriceFeed'

export class NativePriceFeed implements IPriceFeed {
  constructor() {}

  async init() {}

  async getRate(): Promise<BN> {
    return toBN(1)
  }

  convert(_: BN, baseTokenAmount: BN): BN {
    return baseTokenAmount
  }
}
