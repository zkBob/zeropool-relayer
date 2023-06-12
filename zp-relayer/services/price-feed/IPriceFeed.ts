import type BN from 'bn.js'

export interface IPriceFeed {
  convert(baseTokenAmounts: BN[]): Promise<BN[]>
}
