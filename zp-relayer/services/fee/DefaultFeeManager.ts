import {
  FeeManager,
  FeeEstimate,
  DefaultUserFeeOptions,
  IFeeEstimateParams,
  IGetFeesParams,
  IFeeManagerConfig,
} from './FeeManager'
import { toBN } from 'web3-utils'

export class DefaultFeeManager extends FeeManager {
  constructor(config: IFeeManagerConfig) {
    super(config)
  }

  async init() {}

  async _estimateFee(_params: IFeeEstimateParams, feeOptions: DefaultUserFeeOptions) {
    const fee = feeOptions.getObject().fee
    return new FeeEstimate(toBN(fee))
  }

  async _getFees({ gasLimit }: IGetFeesParams) {
    const baseFee = await this.estimateExecutionFee(gasLimit)
    return new DefaultUserFeeOptions(baseFee)
  }
}
