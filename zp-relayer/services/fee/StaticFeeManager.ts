import type BN from 'bn.js'
import { FeeManager, FeeEstimate, DefaultUserFeeOptions, IFeeManagerConfig } from './FeeManager'

export class StaticFeeManager extends FeeManager {
  constructor(config: IFeeManagerConfig, private readonly staticFee: BN) {
    super(config)
  }

  async init() {}

  async _estimateFee() {
    return new FeeEstimate(this.staticFee)
  }

  async _getFees() {
    return new DefaultUserFeeOptions(this.staticFee)
  }
}
