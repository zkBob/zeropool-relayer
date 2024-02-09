import type { TransactionConfig } from 'web3-core'
import type { EthereumContract } from './evm/EvmContract'
import type { TronContract } from './tron/TronContract'

export enum Network {
  Tron = 'tron',
  Ethereum = 'ethereum',
}

interface BaseBackendConfig {
  poolAddress: string
  tokenAddress: string
  rpcUrls: string[]
  requireHTTPS: boolean
}

interface EvmBackendConfig extends BaseBackendConfig {
  rpcRequestTimeout: number
  rpcSyncCheckInterval: number
  jsonRpcErrorCodes: number[]
  withRedundantProvider: boolean
}

interface TronBackendConfig extends BaseBackendConfig {}

export type NetworkBackendConfig<N extends Network> = N extends Network.Tron ? TronBackendConfig : EvmBackendConfig

export type NetworkContract<N extends Network> = N extends Network.Tron ? TronContract : EthereumContract

type BaseTxDesc = Required<Pick<TransactionConfig, 'to' | 'value' | 'data'>>

export type TxDesc = BaseTxDesc

export type TxOptions = {
  func?: string
  isResend?: boolean
  shouldUpdateGasPrice?: boolean
  maxFeeLimit?: number
}

export type PreparedTx = {
  rawTransaction: string
}

export interface SendTx<E> {
  txDesc: TxDesc
  extraData: E | null
  options: TxOptions
}

export interface TxInfo {
  blockNumber: number
  txHash: string
  success: boolean
}

export interface SendAttempt<E> {
  txHash: string
  extraData: E
}

export enum SendError {
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  NONCE_ERROR = 'NONCE_ERROR',
  GAS_PRICE_ERROR = 'GAS_PRICE_ERROR',
}

export interface TransactionManager<E> {
  init(): Promise<void>
  confirmTx(txHashes: string[]): Promise<[TxInfo | null, boolean]>
  prepareTx(sendTx: SendTx<E>): Promise<[PreparedTx, SendAttempt<E>]>
  sendTx(sendTx: SendTx<E>): Promise<[PreparedTx, SendAttempt<E>]>
  sendPreparedTx(preparedTx: [PreparedTx, SendAttempt<E>]): Promise<[PreparedTx, SendAttempt<E>]>
  resendTx(sendAttempts: SendAttempt<E>[]): Promise<{
    attempt?: SendAttempt<E>
    error?: SendError
  }>
}

export interface INetworkContract {
  abi: any[]
  instance: any
  address(): string
  call(method: string, args: any[]): Promise<any>
  callRetry(method: string, args: any[]): Promise<any>
  getEvents(event: string): Promise<any[]>
}
