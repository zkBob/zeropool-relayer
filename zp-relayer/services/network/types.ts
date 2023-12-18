import BN from 'bn.js'
import type { TransactionConfig } from 'web3-core'
import type { EthereumContract } from './evm/EvmContract'
import type { TronContract } from './tron/TronContract'
import { EstimationType } from '../gas-price'
import type { Redis } from 'ioredis'

export enum Network {
  Tron = 'tron',
  Ethereum = 'ethereum',
}

interface BaseBackendConfig {
  poolAddress: string
  tokenAddress: string
  pk: string
  rpcUrls: string[]
  requireHTTPS: boolean
}

interface EvmBackendConfig extends BaseBackendConfig {
  rpcRequestTimeout: number
  rpcSyncCheckInterval: number
  jsonRpcErrorCodes: number[]
  relayerTxRedundancy: boolean

  gasPriceFallback: string
  gasPriceUpdateInterval: number
  gasPriceEstimationType: EstimationType
  gasPriceSpeedType: string
  gasPriceFactor: number
  gasPriceMaxFeeLimit: BN | null
  gasPriceBumpFactor: number
  gasPriceSurplus: number

  redis: Redis
}

interface TronBackendConfig extends BaseBackendConfig {}

export type NetworkBackendConfig<N extends Network> = N extends Network.Tron ? TronBackendConfig : EvmBackendConfig

export type NetworkContract<N extends Network> = N extends Network.Tron ? TronContract : EthereumContract

type BaseTxDesc = Required<Pick<TransactionConfig, 'to' | 'value' | 'data'>>
type EvmTxDesc = TransactionConfig
type TronTxDesc = BaseTxDesc

export type TxDesc<N extends Network> = N extends Network.Tron
  ? TronTxDesc & {
      func: string
      feeLimit: number
    }
  : EvmTxDesc & {
      isResend?: boolean
      shouldUpdateGasPrice?: boolean
    }

export interface EvmTx extends TransactionConfig {}
export interface TronTx {
  tx: {}
}
export type Tx<N extends Network> = N extends Network.Tron ? TronTx : EvmTx

export interface SendTx<N extends Network> {
  txDesc: TxDesc<N>
  onSend: (txHash: string) => Promise<void>
  onIncluded: (txHash: string) => Promise<void>
  onRevert: (txHash: string) => Promise<void>
  onResend?: (txHash: string) => Promise<void>
}

export interface TransactionManager<N extends Network> {
  txQueue: SendTx<N>[]
  init(): Promise<void>
  sendTx(sendTx: SendTx<N>): Promise<void>
  // sendTx(tx: Tx<N>): Promise<void>
}

export interface INetworkContract {
  abi: any[]
  instance: any
  address(): string
  call(method: string, args: any[]): Promise<any>
  callRetry(method: string, args: any[]): Promise<any>
  getEvents(event: string): Promise<any[]>
}
