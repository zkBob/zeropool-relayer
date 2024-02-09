import relayerConfig from '@/configs/relayerConfig'
import { NZERO_BYTE_GAS } from '@/utils/constants'
import { toBN } from 'web3-utils'
import type { EstimationType, GasPrice } from '../gas-price'
import { DynamicFeeOptions, FeeEstimate, FeeManager, IFeeEstimateParams, IFeeManagerConfig } from './FeeManager'

export class DynamicFeeManager extends FeeManager {
  constructor(config: IFeeManagerConfig, private gasPrice: GasPrice<EstimationType>) {
    super(config)
  }

  async init() {}

  async _estimateFee({ txType, nativeConvert, txData }: IFeeEstimateParams, feeOptions: DynamicFeeOptions) {
    const { [txType]: baseFee, nativeConvertFee, oneByteFee } = feeOptions.fees
    // -1 to account for the 0x prefix
    const calldataLen = (txData.length >> 1) - 1
    const fee = baseFee.add(oneByteFee.muln(calldataLen))
    if (nativeConvert) {
      fee.iadd(nativeConvertFee)
    }
    return new FeeEstimate({ fee })
  }

  async _fetchFeeOptions(): Promise<DynamicFeeOptions> {
    const gasPrice = await this.gasPrice.fetchOnce()
    const oneByteFee = FeeManager.executionFee(gasPrice, toBN(NZERO_BYTE_GAS))
    return DynamicFeeOptions.fromGasPice(gasPrice, oneByteFee, relayerConfig.RELAYER_MIN_BASE_FEE)
  }
}
