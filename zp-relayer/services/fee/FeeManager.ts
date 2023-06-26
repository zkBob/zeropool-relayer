import type BN from 'bn.js'
import { toBN } from 'web3-utils'
import type { IPriceFeed } from '../price-feed/IPriceFeed'
import { GasPrice, EstimationType, getMaxRequiredGasPrice } from '../gas-price'
import { setIntervalAndRun } from '@/utils/helpers'
import { logger } from '../appLogger'

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
  clone(): this
}

type FeeOptions<K extends string, V = BN> = Required<Record<K, V>>

export class UserFeeOptions<T extends string> implements IUserFeeOptions {
  constructor(protected fees: FeeOptions<T>) {}

  private mapI(f: (_: BN) => BN) {
    for (const k in this.fees) {
      this.fees[k] = f(this.fees[k])
    }
  }

  private map<V>(f: (_: BN) => V): FeeOptions<T, V> {
    const clone = {} as any
    for (const k in this.fees) {
      clone[k] = f(this.fees[k])
    }
    return clone
  }

  applyFactor(factor: BN) {
    this.mapI(p => p.mul(factor).divn(100))
    return this
  }

  denominate(denominator: BN): this {
    this.mapI(p => p.div(denominator))
    return this
  }

  async convert(priceFeed: IPriceFeed) {
    const rate = await priceFeed.getRate()
    this.mapI(p => priceFeed.convert(rate, p))
    return this
  }

  clone() {
    return new UserFeeOptions(this.map(p => p.clone())) as this
  }

  getObject() {
    return this.map(p => p.toString(10))
  }
}

export type DynamicFeeOptions = UserFeeOptions<'fee' | 'oneByteFee'>

// Utility class for internal fee estimations
export class FeeEstimate extends UserFeeOptions<'fee'> {
  getEstimate() {
    return this.fees.fee
  }
}


export interface IFeeManagerConfig {
  priceFeed: IPriceFeed
  scaleFactor: BN
  marginFactor: BN
  updateInterval: number
  defaultFeeOptionsParams: IGetFeesParams
}

export abstract class FeeManager {
  private cachedFeeOptions: IUserFeeOptions | null = null
  private updateFeeOptionsInterval: NodeJS.Timeout | null = null

  constructor(protected config: IFeeManagerConfig) {}

  protected abstract init(): Promise<void>

  async start() {
    await this.init()

    if (this.updateFeeOptionsInterval) clearInterval(this.updateFeeOptionsInterval)

    this.updateFeeOptionsInterval = await setIntervalAndRun(async () => {
      const feeOptions = await this.fetchFeeOptions(this.config.defaultFeeOptionsParams)
      logger.debug('Updating cached fee options', {
        old: this.cachedFeeOptions?.getObject(),
        new: feeOptions.getObject(),
      })
      this.cachedFeeOptions = feeOptions
    }, this.config.updateInterval)
  }

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
    const fees = await this.getFeeOptions(params, false)
    const estimatedFee = await this._estimateFee(params, fees)
    const marginedFee = estimatedFee.applyFactor(this.config.marginFactor)
    return marginedFee
  }

  async fetchFeeOptions(params: IGetFeesParams): Promise<IUserFeeOptions> {
    const feeOptions = await this._fetchFeeOptions(params)
    const convertedFees = await this.convertAndScale(feeOptions)

    return convertedFees
  }

  async getFeeOptions(params: IGetFeesParams, useCached = true): Promise<IUserFeeOptions> {
    if (useCached && this.cachedFeeOptions) return this.cachedFeeOptions.clone()
    let feeOptions: IUserFeeOptions
    try {
      feeOptions = await this.fetchFeeOptions(params)
      logger.debug('Fetched fee options', feeOptions.getObject())
    } catch (e) {
      logger.error('Failed to fetch fee options', e)
      if (!this.cachedFeeOptions) throw e
      logger.debug('Fallback to cache fee options')
      feeOptions = this.cachedFeeOptions.clone()
    }
    return feeOptions
  }

  // Should be used for tx fee validation
  protected abstract _estimateFee(params: IFeeEstimateParams, fees: IUserFeeOptions): Promise<FeeEstimate>

  // Should provide fee estimations for users
  protected abstract _fetchFeeOptions(params: IGetFeesParams): Promise<IUserFeeOptions>
}
