import BN from 'bn.js'
import type Web3 from 'web3'
import { toWei, toBN } from 'web3-utils'
import config from '@/config'
import { setIntervalAndRun } from '@/utils/helpers'
import { estimateFees } from '@mycrypto/gas-estimation'
import { GasPriceOracle } from 'gas-price-oracle'
import { logger } from '@/services/appLogger'
import {
  EstimationType,
  FetchFunc,
  EstimationOptions,
  GasPriceValue,
  EstimationEIP1559,
  EstimationOracle,
  EstimationPolygonGSV2,
  EstimationWeb3,
  PolygonGSV2Response,
  PolygonGSV2GasPriceKey,
  GasPriceKey,
  LegacyGasPrice,
  EIP1559GasPrice,
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

export class GasPrice<ET extends EstimationType> {
  private fetchGasPriceInterval: NodeJS.Timeout | null = null
  private cachedGasPrice: GasPriceValue
  private updateInterval: number
  private fetchGasPrice: FetchFunc<ET>
  private options: EstimationOptions<ET>
  private web3: Web3

  static defaultGasPrice = { gasPrice: config.gasPriceFallback }

  constructor(web3: Web3, updateInterval: number, estimationType: ET, options: EstimationOptions<ET>) {
    this.cachedGasPrice = GasPrice.defaultGasPrice
    this.updateInterval = updateInterval
    this.web3 = web3
    this.fetchGasPrice = this.getFetchFunc(estimationType)
    this.options = options
  }

  async start() {
    if (this.fetchGasPriceInterval) clearInterval(this.fetchGasPriceInterval)

    this.fetchGasPriceInterval = await setIntervalAndRun(async () => {
      try {
        this.cachedGasPrice = await this.fetchGasPrice(this.options)
        logger.info('Updated gasPrice: %o', this.cachedGasPrice)
      } catch (e) {
        logger.warn('Failed to fetch gasPrice %o; using default value', e)
        this.cachedGasPrice = GasPrice.defaultGasPrice
      }
    }, this.updateInterval)
  }

  getPrice() {
    return this.cachedGasPrice
  }

  private getFetchFunc(estimationType: EstimationType): FetchFunc<EstimationType> {
    const funcs: Record<EstimationType, FetchFunc<EstimationType>> = {
      'web3': this.fetchWeb3,
      'eip1559-gas-estimation': this.fetchEIP1559,
      'gas-price-oracle': this.fetchGasPriceOracle,
      'polygon-gasstation-v2': this.fetchPolygonGasStationV2,
    }
    return funcs[estimationType]
  }

  private fetchEIP1559: FetchFunc<EstimationEIP1559> = async () => {
    // @ts-ignore
    const options = await estimateFees(this.web3)
    const res = {
      maxFeePerGas: options.maxFeePerGas.toString(10),
      maxPriorityFeePerGas: options.maxPriorityFeePerGas.toString(10),
    }
    return res
  }

  private fetchWeb3: FetchFunc<EstimationWeb3> = async () => {
    const gasPrice = await this.web3.eth.getGasPrice()
    return { gasPrice }
  }

  private fetchGasPriceOracle: FetchFunc<EstimationOracle> = async options => {
    const gasPriceOracle = new GasPriceOracle()
    const json = await gasPriceOracle.legacy.fetchGasPricesOffChain()
    const gasPrice = GasPrice.normalizeGasPrice(json[options.speedType], options.factor)
    return { gasPrice }
  }

  private fetchPolygonGasStationV2: FetchFunc<EstimationPolygonGSV2> = async options => {
    const response = await fetch('https://gasstation-mainnet.matic.network/v2')
    const json: PolygonGSV2Response = await response.json()
    const speedType = polygonGasPriceKeyMapping[options.speedType]
    const { maxFee, maxPriorityFee } = json[speedType]
    return {
      maxFeePerGas: GasPrice.normalizeGasPrice(maxFee),
      maxPriorityFeePerGas: GasPrice.normalizeGasPrice(maxPriorityFee),
    }
  }

  static normalizeGasPrice(rawGasPrice: number, factor = 1) {
    const gasPrice = rawGasPrice * factor
    return toWei(gasPrice.toFixed(2).toString(), 'gwei')
  }
}
