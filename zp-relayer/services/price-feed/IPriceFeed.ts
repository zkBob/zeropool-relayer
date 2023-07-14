import type BN from 'bn.js'

export interface IPriceFeed {
  init(): Promise<void>
  getRate(): Promise<BN>
  convert(rate: BN, baseTokenAmounts: BN): BN
}
