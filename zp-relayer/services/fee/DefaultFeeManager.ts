import type BN from 'bn.js'
import type { EstimationType, GasPrice } from '../gas-price'
import { FeeManager, IFeeEstimateParams, IFeeOptions, IGetFeesParams } from './FeeManager'
import { IPriceFeed } from '../price-feed/IPriceFeed'

export class DefaultFeeManager extends FeeManager {
  constructor(gasPrice: GasPrice<EstimationType>, priceFeed: IPriceFeed, scaleFactor: BN) {
    super(gasPrice, priceFeed, scaleFactor)
  }

  async estimateFee({ gasLimit }: IFeeEstimateParams): Promise<BN> {
    const baseFee = await this.estimateExecutionFee(gasLimit)
    const [fee] = await this.priceFeed.convert([baseFee])

    return this.applyScaleFactor(fee)
  }

  async getFees({ gasLimit }: IGetFeesParams): Promise<IFeeOptions> {
    const baseFee = await this.estimateExecutionFee(gasLimit)
    const [fee] = await this.priceFeed.convert([baseFee])

    return {
      fee: fee.toString(10),
    }
  }
}
