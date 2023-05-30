import type BN from 'bn.js'
import { toBN } from 'web3-utils'
import type { IPriceFeed } from '../price-feed/IPriceFeed'
import { GasPrice, EstimationType, getMaxRequiredGasPrice } from '../gas-price'

export interface IGetFeesParams {
  gasLimit: BN
}
export interface IFeeEstimateParams extends IGetFeesParams {
  extraData: string
}

export interface IUserFeeOptions {
  applyFactor(factor: BN): this
  denominate(denominator: BN): this
  convert(priceFeed: IPriceFeed): Promise<this>
  getObject(): Record<string, string>
}

export class DefaultUserFeeOptions implements IUserFeeOptions {
  constructor(protected fee: BN) {}

  applyFactor(factor: BN) {
    this.fee = this.fee.mul(factor).divn(100)
    return this
  }

  denominate(denominator: BN): this {
    this.fee = this.fee.div(denominator)
    return this
  }

  async convert(priceFeed: IPriceFeed) {
    const [fee] = await priceFeed.convert([this.fee])
    this.fee = fee
    return this
  }

  getObject() {
    return {
      fee: this.fee.toString(10),
    }
  }
}

export class FeeEstimate extends DefaultUserFeeOptions {
  getEstimate() {
    return this.fee
  }
}

export interface IFeeManagerConfig {
  priceFeed: IPriceFeed
  scaleFactor: BN
  marginFactor: BN
}

export abstract class FeeManager {
  constructor(protected config: IFeeManagerConfig) {}

  abstract init(): Promise<void>

  static async estimateExecutionFee(gasPrice: GasPrice<EstimationType>, gasLimit: BN): Promise<BN> {
    const price = await gasPrice.fetchOnce()
    return toBN(getMaxRequiredGasPrice(price)).mul(gasLimit)
  }

  private async convertAndScale<T extends IUserFeeOptions>(baseFee: T) {
    const fees = await baseFee.convert(this.config.priceFeed)
    const scaledFees = fees.applyFactor(this.config.scaleFactor)
    return scaledFees
  }

  async estimateFee(params: IFeeEstimateParams): Promise<FeeEstimate> {
    const fees = await this.getFees(params)
    const estimatedFee = await this._estimateFee(params, fees)
    const marginedFee = estimatedFee.applyFactor(this.config.marginFactor)
    return marginedFee
  }

  async getFees(params: IGetFeesParams): Promise<IUserFeeOptions> {
    const feeOptions = await this._getFees(params)
    const convertedFees = await this.convertAndScale(feeOptions)
    return convertedFees
  }

  // Should be used for tx fee validation
  protected abstract _estimateFee(params: IFeeEstimateParams, fees: IUserFeeOptions): Promise<FeeEstimate>

  // Should provide fee estimations for users
  protected abstract _getFees(params: IGetFeesParams): Promise<IUserFeeOptions>
}
