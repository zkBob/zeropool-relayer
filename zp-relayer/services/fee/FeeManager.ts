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

export interface IUserFeeOptions {
  applyFactor(factor: BN): this
  denominate(denominator: BN): this
  convert(priceFeed: IPriceFeed): Promise<this>
  getObject(): Record<string, string>
}

export interface IFeeEstimate extends IUserFeeOptions {
  getEstimate(): BN
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

export class DefaultFeeEstimate extends DefaultUserFeeOptions implements IFeeEstimate {
  getEstimate() {
    return this.fee
  }
}

export interface IFeeManagerConfig {
  gasPrice: GasPrice<EstimationType>
  priceFeed: IPriceFeed
  scaleFactor: BN
  marginFactor: BN
}

export abstract class FeeManager {
  constructor(protected config: IFeeManagerConfig) {}

  protected async estimateExecutionFee(gasLimit: BN): Promise<BN> {
    const gasPrice = await this.config.gasPrice.fetchOnce()
    return toBN(getMaxRequiredGasPrice(gasPrice)).mul(gasLimit)
  }

  private async convertAndScale<T extends IUserFeeOptions>(baseFee: T) {
    const fees = await baseFee.convert(this.config.priceFeed)
    const scaledFees = fees.applyFactor(this.config.scaleFactor)
    return scaledFees
  }

  async estimateFee(params: IFeeEstimateParams): Promise<IFeeEstimate> {
    const baseFee = await this._estimateFee(params)
    const fee = await this.convertAndScale(baseFee)
    const marginedFee = fee.applyFactor(this.config.marginFactor)
    return marginedFee
  }

  async getFees(params: IGetFeesParams): Promise<IUserFeeOptions> {
    const baseFees = await this._getFees(params)
    const fees = await this.convertAndScale(baseFees)
    return fees
  }

  // Should be used for tx fee validation
  protected abstract _estimateFee(params: IFeeEstimateParams): Promise<IFeeEstimate>

  // Should provide fee estimations for users
  protected abstract _getFees(params: IGetFeesParams): Promise<IUserFeeOptions>
}
