import AccountingAbi from '@/abi/accounting-abi.json'
import PoolAbi from '@/abi/pool-abi.json'
import TokenAbi from '@/abi/token-abi.json'
import RedundantHttpListProvider from '@/lib/providers/RedundantHttpListProvider'
import { RETRY_CONFIG } from '@/utils/constants'
import { checkHTTPS } from '@/utils/helpers'
import { getEvents } from '@/utils/web3'
import promiseRetry from 'promise-retry'
import Web3 from 'web3'
import type { HttpProvider } from 'web3-core'
import { AbiItem } from 'web3-utils'
import HttpListProvider from '../../providers/HttpListProvider'
import { SafeEthLogsProvider } from '../../providers/SafeEthLogsProvider'
import type { GetEventsConfig, INetworkBackend } from '../NetworkBackend'
import { Network, NetworkBackendConfig } from '../types'
import { EthereumContract } from './EvmContract'

export class EvmBackend implements INetworkBackend<Network.Ethereum> {
  type: Network.Ethereum = Network.Ethereum
  web3: Web3
  web3Redundant: Web3
  pool: EthereumContract
  token: EthereumContract
  accounting: EthereumContract

  constructor(config: NetworkBackendConfig<Network.Ethereum>) {
    const providerOptions = {
      requestTimeout: config.rpcRequestTimeout,
      retry: RETRY_CONFIG,
    }
    config.rpcUrls.forEach(checkHTTPS(config.requireHTTPS))
    const provider = new HttpListProvider(config.rpcUrls, providerOptions, config.jsonRpcErrorCodes)
    provider.startSyncStateChecker(config.rpcSyncCheckInterval)

    this.web3 = new Web3(SafeEthLogsProvider(provider as HttpProvider))
    this.web3Redundant = this.web3

    if (config.withRedundantProvider && config.rpcUrls.length > 1) {
      const redundantProvider = new RedundantHttpListProvider(config.rpcUrls, {
        ...providerOptions,
        name: 'redundant',
      })
      this.web3Redundant = new Web3(redundantProvider)
    }

    this.pool = this.contract(PoolAbi as AbiItem[], config.poolAddress)
    this.token = this.contract(TokenAbi as AbiItem[], config.tokenAddress)
    this.accounting = this.contract(AccountingAbi as AbiItem[], config.poolAddress)
  }

  async *getEvents({ startBlock, lastBlock, event, batchSize, contract }: GetEventsConfig<Network.Ethereum>) {
    let toBlock = startBlock
    for (let fromBlock = startBlock; fromBlock <= lastBlock; fromBlock = toBlock + 1) {
      toBlock = Math.min(toBlock + batchSize, lastBlock)
      const res = await promiseRetry(
        async retry => {
          const events = await getEvents(contract.instance, event, {
            fromBlock,
            toBlock,
          }).catch(retry)
          return {
            events: events.map(e => ({
              txHash: e.transactionHash,
              values: e.returnValues,
              blockNumber: e.blockNumber,
            })),
            fromBlock,
            toBlock,
          }
        },
        {
          forever: true,
          factor: 2,
        }
      )
      yield res
    }
  }

  async init() {
    try {
      const accountingAddress = await this.pool.call('accounting')
      this.accounting = this.contract(AccountingAbi as AbiItem[], accountingAddress)
    } catch (_) {}
  }

  recover(msg: string, sig: string): Promise<string> {
    return Promise.resolve(this.web3.eth.accounts.recover(msg, sig))
  }

  contract(abi: any[], address: string) {
    return new EthereumContract(this.web3, abi, address)
  }

  public getBlockNumber() {
    return this.web3.eth.getBlockNumber()
  }

  public async getTxCalldata(hash: string): Promise<string> {
    const tx = await this.web3.eth.getTransaction(hash)
    return tx.input
  }
}
