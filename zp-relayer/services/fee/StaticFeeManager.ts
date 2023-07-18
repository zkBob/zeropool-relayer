import type BN from 'bn.js'
import { FeeManager, FeeEstimate, IFeeManagerConfig, FeeOptions } from './FeeManager'

export class StaticFeeManager extends FeeManager {
  constructor(config: IFeeManagerConfig, private readonly staticFee: BN) {
    super(config)
  }

  async init() {}

  async _estimateFee() {
    return new FeeEstimate({
      fee: this.staticFee,
    })
  }

  async _fetchFeeOptions() {
    return new FeeOptions({
      fee: this.staticFee,
    })
  }
}
