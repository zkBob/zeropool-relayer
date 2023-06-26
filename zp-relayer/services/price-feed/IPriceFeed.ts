import type BN from 'bn.js'

export interface IPriceFeed {
  getRate(): Promise<BN>
  convert(rate: BN, baseTokenAmounts: BN): BN
}
