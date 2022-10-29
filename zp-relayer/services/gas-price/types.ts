import type BN from 'bn.js'

// GasPrice fields
export interface LegacyGasPrice {
  gasPrice: string
}
export interface EIP1559GasPrice {
  maxFeePerGas: string
  maxPriorityFeePerGas: string
}
export type GasPriceValue = LegacyGasPrice | EIP1559GasPrice

// In Gwei
export interface PolygonGSV2Response {
  safeLow: {
    maxPriorityFee: number
    maxFee: number
  }
  standard: {
    maxPriorityFee: number
    maxFee: number
  }
  fast: {
    maxPriorityFee: number
    maxFee: number
  }
  estimatedBaseFee: number
  blockTime: number
  blockNumber: number
}

export type GasPriceKey = 'instant' | 'fast' | 'standard' | 'low'
export type PolygonGSV2GasPriceKey = 'safeLow' | 'standard' | 'fast'

// Estimation types
export type EstimationEIP1559 = 'eip1559-gas-estimation'
export type EstimationOracle = 'gas-price-oracle'
export type EstimationWeb3 = 'web3'
export type EstimationPolygonGSV2 = 'polygon-gasstation-v2'
export type EstimationType = EstimationEIP1559 | EstimationOracle | EstimationWeb3 | EstimationPolygonGSV2

export type EstimationOracleOptions = { speedType: GasPriceKey; factor: number }
export type EstimationPolygonGSV2Options = { speedType: GasPriceKey; maxFeeLimit: BN | null }
export type EstimationOptions<ET extends EstimationType> = ET extends EstimationOracle
  ? EstimationOracleOptions
  : ET extends EstimationPolygonGSV2
  ? EstimationPolygonGSV2Options
  : {}

export type FetchFunc<ET extends EstimationType> = (_: EstimationOptions<ET>) => Promise<GasPriceValue>
