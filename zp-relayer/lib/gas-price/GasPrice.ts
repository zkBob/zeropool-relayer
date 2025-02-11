import OracleAbi from '@/abi/op-oracle.json'
import { logger } from '@/lib/appLogger'
import constants from '@/utils/constants'
import { contractCallRetry, setIntervalAndRun } from '@/utils/helpers'
import { estimateFees } from '@mycrypto/gas-estimation'
import BigNumber from 'bignumber.js'
import BN from 'bn.js'
import { GasPriceOracle } from 'gas-price-oracle'
import type Web3 from 'web3'
import type { TransactionConfig } from 'web3-core'
import { AbiItem, toBN, toWei } from 'web3-utils'
import {
  EIP1559GasPrice,
  EstimationOptions,
  EstimationType,
  FetchFunc,
  GasPriceKey,
  GasPriceValue,
  LegacyGasPrice,
  PolygonGSV2GasPriceKey,
  PolygonGSV2Response,
} from './types'

const polygonGasPriceKeyMapping: Record<GasPriceKey, PolygonGSV2GasPriceKey> = {
  low: 'safeLow',
  standard: 'standard',
  fast: 'fast',
  instant: 'fast',
}

function isLegacyGasPrice(gp: GasPriceValue): gp is LegacyGasPrice {
  return 'gasPrice' in gp
}

function isEIP1559GasPrice(gp: GasPriceValue): gp is EIP1559GasPrice {
  return 'maxFeePerGas' in gp && 'maxPriorityFeePerGas' in gp
}

export function getGasPriceValue(tx: TransactionConfig): GasPriceValue | null {
  if ('gasPrice' in tx) {
    return { gasPrice: tx.gasPrice as string }
  }
  if ('maxFeePerGas' in tx && 'maxPriorityFeePerGas' in tx) {
    return {
      maxFeePerGas: tx.maxFeePerGas as string,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas as string,
    }
  }
  return null
}

export function getMaxRequiredGasPrice(gp: GasPriceValue): string {
  if (isLegacyGasPrice(gp)) return gp.gasPrice
  if (isEIP1559GasPrice(gp)) return gp.maxFeePerGas
  throw new Error('Unknown gas price type')
}

export function chooseGasPriceOptions(a: GasPriceValue, b: GasPriceValue): GasPriceValue {
  if (isLegacyGasPrice(a) && isLegacyGasPrice(b)) {
    return { gasPrice: BN.max(toBN(a.gasPrice), toBN(b.gasPrice)).toString(10) }
  }
  if (isEIP1559GasPrice(a) && isEIP1559GasPrice(b)) {
    return {
      maxFeePerGas: BN.max(toBN(a.maxFeePerGas), toBN(b.maxFeePerGas)).toString(10),
      maxPriorityFeePerGas: BN.max(toBN(a.maxPriorityFeePerGas), toBN(b.maxPriorityFeePerGas)).toString(10),
    }
  }
  return b
}

export function EIP1559GasPriceWithinLimit(gp: EIP1559GasPrice, maxFeeLimit: BN): EIP1559GasPrice {
  if (!maxFeeLimit) return gp

  const diff = toBN(gp.maxFeePerGas).sub(maxFeeLimit)
  if (diff.isNeg()) {
    return gp
  } else {
    const maxFeePerGas = maxFeeLimit.toString(10)
    const maxPriorityFeePerGas = BN.min(toBN(gp.maxPriorityFeePerGas), maxFeeLimit).toString(10)
    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
    }
  }
}

export function LegacyGasPriceWithinLimit(gp: LegacyGasPrice, maxFeeLimit: BN): LegacyGasPrice {
  if (!maxFeeLimit) return gp

  return {
    gasPrice: BN.min(toBN(gp.gasPrice), maxFeeLimit).toString(10),
  }
}

export function gasPriceWithinLimit(gp: GasPriceValue, maxFeeLimit: BN | null): GasPriceValue {
  if (!maxFeeLimit) return gp
  if (isEIP1559GasPrice(gp)) {
    return EIP1559GasPriceWithinLimit(gp, maxFeeLimit)
  }
  if (isLegacyGasPrice(gp)) {
    return LegacyGasPriceWithinLimit(gp, maxFeeLimit)
  }
  return gp
}

function addExtraGas(gas: BN, extraPercentage: number, maxGasLimit: string | undefined): BN {
  const factor = BigNumber(1 + extraPercentage)

  const gasWithExtra = BigNumber(gas.toString(10)).multipliedBy(factor).toFixed(0)

  if (maxGasLimit) {
    return toBN(BigNumber.min(maxGasLimit, gasWithExtra).toString(10))
  } else {
    return toBN(gasWithExtra)
  }
}

export function addExtraGasPrice(gp: GasPriceValue, factor: number, maxFeeLimit: BN | null): GasPriceValue {
  if (factor === 0) return gp

  const maxGasPrice = maxFeeLimit?.toString()

  if (isLegacyGasPrice(gp)) {
    return {
      gasPrice: addExtraGas(toBN(gp.gasPrice), factor, maxGasPrice).toString(),
    }
  }
  if (isEIP1559GasPrice(gp)) {
    return {
      maxFeePerGas: addExtraGas(toBN(gp.maxFeePerGas), factor, maxGasPrice).toString(),
      maxPriorityFeePerGas: addExtraGas(toBN(gp.maxPriorityFeePerGas), factor, maxGasPrice).toString(),
    }
  }
  return gp
}

export class GasPrice<ET extends EstimationType> {
  private fetchGasPriceInterval: NodeJS.Timeout | null = null
  private cachedGasPrice: GasPriceValue
  private readonly defaultGasPrice: GasPriceValue
  private updateInterval: number
  private fetchGasPrice: FetchFunc<ET>
  private options: EstimationOptions<ET>
  private web3: Web3

  constructor(
    web3: Web3,
    fallbackGasPrice: GasPriceValue,
    updateInterval: number,
    estimationType: ET,
    options: EstimationOptions<ET>
  ) {
    this.defaultGasPrice = fallbackGasPrice
    this.cachedGasPrice = this.defaultGasPrice
    this.updateInterval = updateInterval
    this.web3 = web3
    this.fetchGasPrice = this.getFetchFunc(estimationType)
    this.options = options
  }

  async start() {
    if (this.fetchGasPriceInterval) clearInterval(this.fetchGasPriceInterval)

    this.fetchGasPriceInterval = await setIntervalAndRun(() => {
      this.fetchOnce()
    }, this.updateInterval)
  }

  async fetchOnce(shouldUpdateCache = true) {
    let gasPrice
    try {
      gasPrice = await this.fetchGasPrice(this.options)
    } catch (e) {
      logger.warn('Failed to fetch gasPrice %s; using previous value', (e as Error).message)
      gasPrice = chooseGasPriceOptions(this.defaultGasPrice, this.cachedGasPrice)
    }
    if (shouldUpdateCache) {
      this.setGasPrice(gasPrice)
      logger.info('Updated gasPrice: %o', gasPrice)
    }
    return gasPrice
  }

  stop() {
    if (this.fetchGasPriceInterval) clearInterval(this.fetchGasPriceInterval)
  }

  setGasPrice(gp: GasPriceValue) {
    this.cachedGasPrice = gp
  }

  getPrice() {
    return this.cachedGasPrice
  }

  private getFetchFunc(estimationType: ET): FetchFunc<ET> {
    const funcs: Record<EstimationType, FetchFunc<EstimationType>> = {
      [EstimationType.Web3]: this.fetchWeb3,
      [EstimationType.EIP1559]: this.fetchEIP1559,
      [EstimationType.Oracle]: this.fetchGasPriceOracle,
      [EstimationType.PolygonGSV2]: this.fetchPolygonGasStationV2,
      [EstimationType.OptimismOracle]: this.fetchOptimismOracle,
      [EstimationType.Tron]: this.fetchTron,
    }
    return funcs[estimationType]
  }

  private fetchEIP1559: FetchFunc<EstimationType.EIP1559> = async () => {
    // @ts-ignore
    const options = await estimateFees(this.web3)
    const res = {
      maxFeePerGas: options.maxFeePerGas.toString(10),
      maxPriorityFeePerGas: options.maxPriorityFeePerGas.toString(10),
    }
    return res
  }

  private fetchWeb3: FetchFunc<EstimationType.Web3> = async () => {
    const gasPrice = await this.web3.eth.getGasPrice()
    return { gasPrice }
  }

  private fetchGasPriceOracle: FetchFunc<EstimationType.Oracle> = async options => {
    const gasPriceOracle = new GasPriceOracle()
    const json = await gasPriceOracle.legacy.fetchGasPricesOffChain()
    const gasPrice = GasPrice.normalizeGasPrice(json[options.speedType], options.factor)
    return { gasPrice }
  }

  private fetchPolygonGasStationV2: FetchFunc<EstimationType.PolygonGSV2> = async options => {
    const response = await fetch('https://gasstation.polygon.technology/v2')
    const json: PolygonGSV2Response = await response.json()
    const speedType = polygonGasPriceKeyMapping[options.speedType]
    const { maxFee, maxPriorityFee } = json[speedType]

    let gasPriceOptions = {
      maxFeePerGas: GasPrice.normalizeGasPrice(maxFee),
      maxPriorityFeePerGas: GasPrice.normalizeGasPrice(maxPriorityFee),
    }

    // Check for possible gas-station invalid response
    gasPriceOptions.maxPriorityFeePerGas = BN.min(
      toBN(gasPriceOptions.maxFeePerGas),
      toBN(gasPriceOptions.maxPriorityFeePerGas)
    ).toString(10)

    if (options.maxFeeLimit) {
      gasPriceOptions = EIP1559GasPriceWithinLimit(gasPriceOptions, options.maxFeeLimit)
    }

    return gasPriceOptions
  }

  private fetchOptimismOracle: FetchFunc<EstimationType.OptimismOracle> = async () => {
    const oracle = new this.web3.eth.Contract(OracleAbi as AbiItem[], constants.OP_GAS_ORACLE_ADDRESS)
    const gasPrice = await contractCallRetry(oracle, 'gasPrice')
    return { gasPrice }
  }

  private fetchTron: FetchFunc<EstimationType.Tron> = async () => {
    return { gasPrice: '0' }
  }

  static normalizeGasPrice(rawGasPrice: number, factor = 1) {
    const gasPrice = rawGasPrice * factor
    return toWei(gasPrice.toFixed(2).toString(), 'gwei')
  }
}
