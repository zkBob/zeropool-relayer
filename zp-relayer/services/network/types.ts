import type { TransactionConfig } from 'web3-core'
import type { EthereumContract } from './evm/EvmBackend'
import type { TronContract } from './tron/TronBackend'

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
    }
  : EvmTxDesc & {
      isResend?: boolean
      shouldUpdateGasPrice?: boolean
    }

// interface TronPrepareTxConfig
// export type PrepareTxConfig<N extends Network> = N extends Network.Tron ? TronPrepareTxConfig : EvmPrepareTxConfig

export interface EvmTx extends TransactionConfig {}
export interface TronTx {
  tx: {}
}
// {
//   result: { result: true },
//   transaction: {
//     visible: false,
//     txID: '2e3cfe002928451caeddaa56740cf9cba12220e0246fe09f26d9ba9a7e4093b4',
//     raw_data: {
//       contract: [Array],
//       ref_block_bytes: '6630',
//       ref_block_hash: '046df9e75a1cc467',
//       expiration: 1692285951000,
//       fee_limit: 100000000,
//       timestamp: 1692285893195
//     },
//     raw_data_hex: '0a0266302208046df9e75a1cc4674098b8e9a0a0315a8e01081f1289010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412540a1541c583bb73a1d811eee60eb1e078d35c555cbed8531215419d09bfe09180d54950a92606532526878d6f4f272224514b1520000000000000000000000000726dca7eeaadeef5ab7902c92a85ccced7bb022770cbf4e5a0a031900180c2d72f'
//   }
// }
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
