import { Network, NetworkContract } from './types'

export function isTron(n: NetworkBackend<Network>): n is NetworkBackend<Network.Tron> {
  return n.type === Network.Tron
}

export function isEthereum(n: NetworkBackend<Network>): n is NetworkBackend<Network.Ethereum> {
  return n.type === Network.Ethereum
}

export interface Event {
  txHash: string
  values: Record<string, any>
}

export interface GetEventsConfig<N extends Network> {
  contract: NetworkContract<N>
  event: string
  startBlock: number
  lastBlock: number
  batchSize: number
}
export interface INetworkBackend<N extends Network> {
  type: N
  pool: NetworkContract<N>
  token: NetworkContract<N>
  accounting: NetworkContract<N>

  init(): Promise<void>
  contract(abi: any[], address: string): NetworkContract<N>
  recover(msg: string, sig: string): Promise<string>
  getBlockNumber(): Promise<number>
  getTxCalldata(hash: string): Promise<string>
  getEvents(config: GetEventsConfig<N>): AsyncGenerator<Event[], void>
}

export type NetworkBackend<N extends Network> = INetworkBackend<N>
