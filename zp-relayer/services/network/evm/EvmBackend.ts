import Web3 from 'web3'
import relayerConfig from '@/configs/relayerConfig'
import type { Contract } from 'web3-eth-contract'
import { AbiItem, toBN } from 'web3-utils'
import type { HttpProvider } from 'web3-core'
import { RETRY_CONFIG } from '@/utils/constants'
import { checkHTTPS } from '@/utils/helpers'
import HttpListProvider from '../../providers/HttpListProvider'
import { SafeEthLogsProvider } from '../../providers/SafeEthLogsProvider'
import type { INetworkBackend, NetworkBackend } from '../NetworkBackend'
import PoolAbi from '../../../abi/pool-abi.json'
import TokenAbi from '../../../abi/token-abi.json'
import { INetworkContract, Network, NetworkBackendConfig, TransactionManager } from '../types'
import { EvmTxManager } from './EvmTxManager'
import { EstimationType, GasPrice } from '@/services/gas-price'
import RedundantHttpListProvider from '@/services/providers/RedundantHttpListProvider'

export class EthereumContract implements INetworkContract {
  instance: Contract

  constructor(web3: Web3, public abi: any[], address: string) {
    this.instance = new web3.eth.Contract(abi, address)
  }

  address(): string {
    return this.instance.options.address
  }

  call(method: string, args: any[] = []): Promise<any> {
    return this.instance.methods[method](...args).call()
  }

  callRetry(method: string, args: any[] = []): Promise<any> {
    return this.instance.methods[method](...args).call()
  }

  getEvents(event: string) {
    return this.instance.getPastEvents(event, {
      fromBlock: 0,
      toBlock: 'latest',
    })
  }
}

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
      { gasPrice: relayerConfig.RELAYER_GAS_PRICE_FALLBACK },
      relayerConfig.RELAYER_GAS_PRICE_UPDATE_INTERVAL,
      relayerConfig.RELAYER_GAS_PRICE_ESTIMATION_TYPE,
      {
        speedType: relayerConfig.RELAYER_GAS_PRICE_SPEED_TYPE,
        factor: relayerConfig.RELAYER_GAS_PRICE_FACTOR,
        maxFeeLimit: relayerConfig.RELAYER_MAX_FEE_PER_GAS_LIMIT,
      }
    )

    this.pool = this.contract(PoolAbi as AbiItem[], config.poolAddress)
    this.token = this.contract(TokenAbi as AbiItem[], config.tokenAddress)
    this.txManager = new EvmTxManager(this.web3Redundant, config.pk, this.gasPrice)
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
