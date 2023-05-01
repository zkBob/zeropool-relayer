import type BN from 'bn.js'
import { toBN } from 'web3-utils'
import { GasPrice, EstimationType, getMaxRequiredGasPrice } from '../gas-price'
import type { IPriceFeed } from '../price-feed/IPriceFeed'

export interface IFeeEstimateParams {
  data?: string
  gasLimit: BN
}

export interface IGetFeesParams {
  gasLimit: BN
}

export interface IFeeOptions {
  fee: string
}

export abstract class FeeManager {
  constructor(protected gasPrice: GasPrice<EstimationType>, protected priceFeed: IPriceFeed, private scaleFactor: BN) {}

  protected async estimateExecutionFee(gasLimit: BN): Promise<BN> {
    const gasPrice = await this.gasPrice.fetchOnce()
    return toBN(getMaxRequiredGasPrice(gasPrice)).mul(gasLimit)
  }

  protected applyScaleFactor(fee: BN): BN {
    return fee.mul(this.scaleFactor).divn(100)
  }

  // Should be used for tx fee validation
  abstract estimateFee(params: IFeeEstimateParams): Promise<BN>

  // Should provide fee estimations for users
  abstract getFees(params: IGetFeesParams): Promise<IFeeOptions>
}
