import type { EvmBackend } from './evm/EvmBackend'
import type { TronBackend } from './tron/TronBackend'
import { Network, NetworkContract, TransactionManager } from './types'

export function isTron(n: NetworkBackend<Network>): n is NetworkBackend<Network.Tron> {
  return n.type === Network.Tron
}

export function isEthereum(n: NetworkBackend<Network>): n is NetworkBackend<Network.Ethereum> {
  return n.type === Network.Ethereum
}

export interface INetworkBackend<N extends Network> {
  type: N
  pool: NetworkContract<N>
  token: NetworkContract<N>
  txManager: TransactionManager<N>

  init(): Promise<void>
  contract(abi: any[], address: string): NetworkContract<N>
  recover(msg: string, sig: string): Promise<string>
  getBlockNumber(): Promise<number>
  getTxCalldata(hash: string): Promise<string>
}

export type NetworkBackend<N extends Network> = N extends Network.Tron ? TronBackend : EvmBackend
