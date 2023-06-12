import { toBN } from 'web3-utils'
import {
  FeeManager,
  FeeEstimate,
  DefaultUserFeeOptions,
  IFeeEstimateParams,
  IGetFeesParams,
  IFeeManagerConfig,
} from './FeeManager'
import type { EstimationType, GasPrice } from '../gas-price'

export class DynamicFeeManager extends FeeManager {
  constructor(config: IFeeManagerConfig, private gasPrice: GasPrice<EstimationType>) {
    super(config)
  }

  async init() {}

  async _estimateFee(_params: IFeeEstimateParams, feeOptions: DefaultUserFeeOptions) {
    const fee = feeOptions.getObject().fee
    return new FeeEstimate(toBN(fee))
  }

  async _fetchFeeOptions({ gasLimit }: IGetFeesParams) {
    const baseFee = await FeeManager.estimateExecutionFee(this.gasPrice, gasLimit)
    return new DefaultUserFeeOptions(baseFee)
  }
}
