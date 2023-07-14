import BN from 'bn.js'
import { toBN } from 'web3-utils'
import type { IPriceFeed } from '../price-feed/IPriceFeed'
import { getMaxRequiredGasPrice, GasPriceValue } from '../gas-price'
import { applyDenominator, setIntervalAndRun } from '@/utils/helpers'
import { logger } from '../appLogger'
import { TxType } from 'zp-memo-parser'
import config from '@/configs/relayerConfig'

export interface IFeeEstimateParams {
  txType: TxType
  nativeConvert: boolean
  txData: string
}

interface NestedRecord<T> {
  [key: string]: T | NestedRecord<T>
}

type Fees<K extends string[], V = BN> = { [k in K[number]]: V }
export interface IFeeOptions<K extends string[], V = BN> {
  fees: Fees<K, V>
  applyFactor(factor: BN): this
  applyMinBound(): this
  denominate(denominator: BN): this
  convert(priceFeed: IPriceFeed): Promise<this>
  getObject(): NestedRecord<string>
  clone(): this
}

export class FeeOptions<T extends string[]> implements IFeeOptions<T, BN> {
  constructor(public fees: Fees<T, BN>, private readonly minFees?: Fees<T, BN>) {}

  private mapI(f: (v: BN, k: T[number]) => BN) {
    let k: T[number]
    for (k in this.fees) {
      this.fees[k] = f(this.fees[k], k)
    }
  }

  private mapClone<V>(f: (v: BN, k: T[number]) => V) {
    const clone = {} as Fees<T, V>
    let k: T[number]
    for (k in this.fees) {
      clone[k] = f(this.fees[k], k)
    }
    return clone
  }

  applyFactor(factor: BN) {
    this.mapI(p => p.mul(factor).divn(100))
    return this
  }

  denominate(denominator: BN): this {
    const dInverse = toBN(1).shln(255)
    this.mapI(p => applyDenominator(p, denominator.xor(dInverse)))
    return this
  }

  async convert(priceFeed: IPriceFeed) {
    const rate = await priceFeed.getRate()
    this.mapI(p => priceFeed.convert(rate, p))
    return this
  }

  applyMinBound() {
    const minFees = this.minFees
    if (!minFees) {
      return this
    }
    this.mapI((p, k) => BN.max(p, minFees[k]))
    return this
  }

  clone() {
    const cloneBN = (p: BN) => p.clone()
    // A little hack to not override `clone` for subtypes
    // NOTE: requires all subtypes to have the same constructor signature
    return new (this.constructor as typeof FeeOptions)(this.mapClone(cloneBN), this.minFees) as this
  }

  getObject(): NestedRecord<string> {
    return this.mapClone(p => p.toString(10))
  }
}

type DynamicFeeKeys = [
  TxType.DEPOSIT,
  TxType.PERMITTABLE_DEPOSIT,
  TxType.TRANSFER,
  TxType.WITHDRAWAL,
  'oneByteFee',
  'nativeConvertFee'
]
// Utility class for dynamic fee estimations
export class DynamicFeeOptions extends FeeOptions<DynamicFeeKeys> {
  static fromGasPice(gasPrice: GasPriceValue, oneByteFee: BN, minFee: BN) {
    const getFee = (txType: TxType) => FeeManager.executionFee(gasPrice, config.baseTxGas[txType])
    const fees: Fees<DynamicFeeKeys> = {
      [TxType.DEPOSIT]: getFee(TxType.DEPOSIT),
      [TxType.PERMITTABLE_DEPOSIT]: getFee(TxType.PERMITTABLE_DEPOSIT),
      [TxType.TRANSFER]: getFee(TxType.TRANSFER),
      [TxType.WITHDRAWAL]: getFee(TxType.WITHDRAWAL),
      oneByteFee,
      nativeConvertFee: FeeManager.executionFee(gasPrice, config.baseTxGas.nativeConvertOverhead),
    }
    const minFees: Fees<DynamicFeeKeys> = {
      [TxType.DEPOSIT]: minFee,
      [TxType.PERMITTABLE_DEPOSIT]: minFee,
      [TxType.TRANSFER]: minFee,
      [TxType.WITHDRAWAL]: minFee,
      oneByteFee: toBN(0),
      nativeConvertFee: toBN(0),
    }
    return new DynamicFeeOptions(fees, minFees)
  }

  override getObject() {
    return {
      fee: {
        deposit: this.fees[TxType.DEPOSIT].toString(10),
        transfer: this.fees[TxType.TRANSFER].toString(10),
        withdrawal: this.fees[TxType.WITHDRAWAL].toString(10),
        permittableDeposit: this.fees[TxType.PERMITTABLE_DEPOSIT].toString(10),
      },
      oneByteFee: this.fees.oneByteFee.toString(10),
      nativeConvertFee: this.fees.nativeConvertFee.toString(10),
    }
  }
}

// Utility class for internal fee estimations
export class FeeEstimate extends FeeOptions<['fee']> {
  getEstimate() {
    return this.fees.fee
  }
}

export interface IFeeManagerConfig {
  priceFeed: IPriceFeed
  scaleFactor: BN
  marginFactor: BN
  updateInterval: number
}

export abstract class FeeManager<T extends string[] = DynamicFeeKeys> {
  private cachedFeeOptions: IFeeOptions<T> | null = null
  private updateFeeOptionsInterval: NodeJS.Timeout | null = null

  constructor(protected config: IFeeManagerConfig) {}

  protected abstract init(): Promise<void>

  async start() {
    await this.init()

    if (this.updateFeeOptionsInterval) clearInterval(this.updateFeeOptionsInterval)

    this.updateFeeOptionsInterval = await setIntervalAndRun(async () => {
      const feeOptions = await this.fetchFeeOptions()
      logger.debug('Updating cached fee options', {
        old: this.cachedFeeOptions?.getObject(),
        new: feeOptions.getObject(),
      })
      this.cachedFeeOptions = feeOptions
    }, this.config.updateInterval)
  }

  static executionFee(gasPrice: GasPriceValue, gasLimit: BN): BN {
    return toBN(getMaxRequiredGasPrice(gasPrice)).mul(gasLimit)
  }

  async estimateFee(params: IFeeEstimateParams): Promise<FeeEstimate> {
    const fees = await this.getFeeOptions(false)
    const estimatedFee = await this._estimateFee(params, fees)
    const marginedFee = estimatedFee.applyFactor(this.config.marginFactor)
    return marginedFee
  }

  async fetchFeeOptions(): Promise<IFeeOptions<T>> {
    const feeOptions = await this._fetchFeeOptions()
    const convertedFees = await feeOptions.convert(this.config.priceFeed)
    const scaledFees = convertedFees.applyFactor(this.config.scaleFactor)

    return scaledFees
  }

  async getFeeOptions(useCached = true): Promise<IFeeOptions<T>> {
    if (useCached && this.cachedFeeOptions) return this.cachedFeeOptions.clone()
    let feeOptions: IFeeOptions<T>
    try {
      feeOptions = await this.fetchFeeOptions()
      logger.debug('Fetched fee options', feeOptions.getObject())
    } catch (e) {
      logger.error('Failed to fetch fee options', e)
      if (!this.cachedFeeOptions) throw e
      logger.debug('Fallback to cache fee options')
      feeOptions = this.cachedFeeOptions.clone()
    }
    feeOptions.applyMinBound()
    return feeOptions
  }

  // Should be used for tx fee validation
  protected abstract _estimateFee(params: IFeeEstimateParams, fees: IFeeOptions<T>): Promise<FeeEstimate>

  // Should provide fee estimations for users
  protected abstract _fetchFeeOptions(): Promise<IFeeOptions<T>>
}
