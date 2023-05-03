import {
  FeeManager,
  DefaultFeeEstimate,
  DefaultUserFeeOptions,
  IFeeEstimateParams,
  IGetFeesParams,
  IFeeManagerConfig,
} from './FeeManager'

export class DefaultFeeManager extends FeeManager {
  constructor(config: IFeeManagerConfig) {
    super(config)
  }

  async _estimateFee({ gasLimit }: IFeeEstimateParams) {
    const baseFee = await this.estimateExecutionFee(gasLimit)
    return new DefaultFeeEstimate(baseFee)
  }

  async _getFees({ gasLimit }: IGetFeesParams) {
    const baseFee = await this.estimateExecutionFee(gasLimit)
    return new DefaultUserFeeOptions(baseFee)
  }
}
