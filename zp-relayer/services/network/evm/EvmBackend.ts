import Web3 from 'web3'
import { AbiItem } from 'web3-utils'
import type { HttpProvider } from 'web3-core'
import { RETRY_CONFIG } from '@/utils/constants'
import { checkHTTPS } from '@/utils/helpers'
import HttpListProvider from '../../providers/HttpListProvider'
import { SafeEthLogsProvider } from '../../providers/SafeEthLogsProvider'
import type { INetworkBackend } from '../NetworkBackend'
import PoolAbi from '../../../abi/pool-abi.json'
import TokenAbi from '../../../abi/token-abi.json'
import { Network, NetworkBackendConfig, TransactionManager } from '../types'
import { EvmTxManager } from './EvmTxManager'
import { EstimationType, GasPrice } from '@/services/gas-price'
import RedundantHttpListProvider from '@/services/providers/RedundantHttpListProvider'
import { EthereumContract } from './EvmContract'

export class EvmBackend implements INetworkBackend<Network.Ethereum> {
  type: Network.Ethereum = Network.Ethereum
  web3: Web3
  private web3Redundant: Web3
  pool: EthereumContract
  token: EthereumContract
  txManager: TransactionManager<Network.Ethereum>
  public gasPrice: GasPrice<EstimationType>

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

    if (config.relayerTxRedundancy && config.rpcUrls.length > 1) {
      const redundantProvider = new RedundantHttpListProvider(config.rpcUrls, {
        ...providerOptions,
        name: 'redundant',
      })
      this.web3Redundant = new Web3(redundantProvider)
    }

    this.gasPrice = new GasPrice(
      this.web3,
      { gasPrice: config.gasPriceFallback },
      config.gasPriceUpdateInterval,
      config.gasPriceEstimationType,
      {
        speedType: config.gasPriceSpeedType,
        factor: config.gasPriceFactor,
        maxFeeLimit: config.gasPriceMaxFeeLimit,
      }
    )

    this.pool = this.contract(PoolAbi as AbiItem[], config.poolAddress)
    this.token = this.contract(TokenAbi as AbiItem[], config.tokenAddress)
    this.txManager = new EvmTxManager(this.web3Redundant, config.pk, this.gasPrice, {
      gasPriceBumpFactor: config.gasPriceBumpFactor,
      gasPriceMaxFeeLimit: config.gasPriceMaxFeeLimit,
      gasPriceSurplus: config.gasPriceSurplus,
      redis: config.redis,
    })
  }

  async init() {
    await this.gasPrice.start()
    await this.txManager.init()
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
