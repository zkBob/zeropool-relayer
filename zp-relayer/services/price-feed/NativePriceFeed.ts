import type BN from 'bn.js'
import type { IPriceFeed } from './IPriceFeed'
import { toBN } from 'web3-utils'

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
