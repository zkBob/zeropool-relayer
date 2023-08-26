// @ts-ignore
import TronWeb from 'tronweb'
import { hexToBytes } from 'web3-utils'
import type { INetworkBackend, NetworkBackend } from '../NetworkBackend'
import { INetworkContract, Network, NetworkBackendConfig, TransactionManager } from '../types'
import { TronTxManager } from './TronTxManager'
import PoolAbi from '../../../abi/pool-abi.json'
import TokenAbi from '../../../abi/token-abi.json'

export class TronContract implements INetworkContract {
  instance: any

  constructor(tron: TronWeb, public abi: any[], address: string) {
    this.instance = tron.contract(abi, address)
  }

  address(): string {
    return this.instance.address
  }

  call(method: string, args: any[] = []): Promise<any> {
    return this.instance[method](...args).call()
  }

  callRetry(method: string, args: any[] = []): Promise<any> {
    return this.instance[method](...args).call()
  }

  async getEvents(eventName: string) {
    const res = await this.instance._getEvents({
      eventName,
      size: 0,
      onlyConfirmed: true,
    })
    return res.map((e: any) => ({
      returnValues: e.result,
      transactionHash: e.transaction,
    }))
  }
}

export class TronBackend implements INetworkBackend<Network.Tron> {
  type: Network.Tron = Network.Tron
  tronWeb: any
  pool: TronContract
  token: TronContract
  txManager: TransactionManager<Network.Tron>

  constructor(config: NetworkBackendConfig<Network.Tron>) {
    this.tronWeb = new TronWeb(config.rpcUrls[0], config.rpcUrls[0], config.rpcUrls[0])
    const pk = config.pk.slice(2)
    const callerAddress = this.tronWeb.address.fromPrivateKey(pk)
    // Workaround for https://github.com/tronprotocol/tronweb/issues/90
    this.tronWeb.setAddress(callerAddress)
    this.txManager = new TronTxManager(this.tronWeb, pk)

    this.pool = new TronContract(this.tronWeb, PoolAbi, config.poolAddress)
    this.token = new TronContract(this.tronWeb, TokenAbi, config.tokenAddress)
  }

  async init() {
    await this.txManager.init()
  }

  async recover(msg: string, sig: string): Promise<string> {
    const bytes = hexToBytes(msg)
    const address = await this.tronWeb.trx.verifyMessageV2(bytes, sig)
    return address
  }

  contract(abi: any[], address: string) {
    return new TronContract(this.tronWeb, abi, address)
  }

  getBlockNumber(): Promise<number> {
    throw new Error('Method not implemented.')
  }

  public async getTxCalldata(hash: string): Promise<string> {
    const tx = await this.tronWeb.trx.getTransaction(hash)
    return '0x' + tx.raw_data.contract[0].parameter.value.data
  }
}
