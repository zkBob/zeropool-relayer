import { toBN } from 'web3-utils'
import {
  FeeManager,
  FeeEstimate,
  UserFeeOptions,
  IFeeEstimateParams,
  IGetFeesParams,
  IFeeManagerConfig,
  DynamicFeeOptions,
} from './FeeManager'
import type { EstimationType, GasPrice } from '../gas-price'
import { NZERO_BYTE_GAS } from '@/utils/constants'

export class DynamicFeeManager extends FeeManager {
  constructor(config: IFeeManagerConfig, private gasPrice: GasPrice<EstimationType>) {
    super(config)
  }

  async init() {}

  async _estimateFee({ txData }: IFeeEstimateParams, feeOptions: DynamicFeeOptions) {
    const { fee: baseFee, oneByteFee } = feeOptions.fees
    // -1 to account for the 0x prefix
    const calldataLen = (txData.length >> 1) - 1
    const fee = baseFee.add(oneByteFee.muln(calldataLen))
    return new FeeEstimate({ fee })
  }

  async _fetchFeeOptions({ gasLimit }: IGetFeesParams): Promise<DynamicFeeOptions> {
    const gasPrice = await this.gasPrice.fetchOnce()
    const fee = FeeManager.executionFee(gasPrice, gasLimit)
    const oneByteFee = FeeManager.executionFee(gasPrice, toBN(NZERO_BYTE_GAS))
    return new UserFeeOptions({
      fee,
      oneByteFee,
    })
  }
}
