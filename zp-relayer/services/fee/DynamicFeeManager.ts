import { toBN } from 'web3-utils'
import {
  FeeManager,
  FeeEstimate,
  UserFeeOptions,
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

  async _estimateFee(_params: IFeeEstimateParams, feeOptions: UserFeeOptions<'fee'>) {
    const fee = feeOptions.getObject().fee
    return new FeeEstimate({
      fee: toBN(fee),
    })
  }

  async _fetchFeeOptions({ gasLimit }: IGetFeesParams) {
    const baseFee = await FeeManager.estimateExecutionFee(this.gasPrice, gasLimit)
    return new UserFeeOptions({
      fee: baseFee,
    })
  }
}
