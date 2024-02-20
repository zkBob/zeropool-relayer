import AccountingAbi from '@/abi/accounting-abi.json'
import PoolAbi from '@/abi/pool-abi.json'
import TokenAbi from '@/abi/token-abi.json'
// @ts-ignore
import TronWeb from 'tronweb'
import { hexToBytes } from 'web3-utils'
import type { GetEventsConfig, INetworkBackend } from '../NetworkBackend'
import { Network, NetworkBackendConfig } from '../types'
import { TronContract } from './TronContract'

export class TronBackend implements INetworkBackend<Network.Tron> {
  type: Network.Tron = Network.Tron
  tronWeb: any
  pool: TronContract
  token: TronContract
  accounting: TronContract

  constructor(config: NetworkBackendConfig<Network.Tron>) {
    this.tronWeb = new TronWeb(config.rpcUrls[0], config.rpcUrls[0], config.rpcUrls[0])

    // TODO: Workaround for https://github.com/tronprotocol/tronweb/issues/90
    // Example:
    // const pk = config.pk.slice(2)
    // const callerAddress = this.tronWeb.address.fromPrivateKey(pk)
    // this.tronWeb.setAddress(callerAddress)

    this.pool = new TronContract(this.tronWeb, PoolAbi, config.poolAddress)
    this.token = new TronContract(this.tronWeb, TokenAbi, config.tokenAddress)
    this.accounting = new TronContract(this.tronWeb, AccountingAbi, config.poolAddress)
  }

  async *getEvents({ startBlock, event, batchSize, contract }: GetEventsConfig<Network.Tron>) {
    const block = await this.tronWeb.trx.getBlockByNumber(startBlock)
    const sinceTimestamp = block.block_header.raw_data.timestamp

    let fingerprint = null
    do {
      const events = await this.tronWeb.getEventResult(contract.address(), {
        sinceTimestamp,
        eventName: event,
        onlyConfirmed: true,
        sort: 'block_timestamp',
        size: batchSize,
      })
      if (events.length === 0) {
        break
      }

      yield events.map((e: any) => ({
        txHash: e.transaction,
        values: e.result,
      }))

      fingerprint = events[events.length - 1].fingerprint || null
    } while (fingerprint !== null)
  }

  async init() {
    try {
      const accountingAddress = await this.pool.call('accounting')
      this.accounting = this.contract(AccountingAbi, accountingAddress)
    } catch (_) {}
  }

  async recover(msg: string, sig: string): Promise<string> {
    const bytes = hexToBytes(msg)
    const address = await this.tronWeb.trx.verifyMessageV2(bytes, sig)
    return address
  }

  contract(abi: any[], address: string) {
    return new TronContract(this.tronWeb, abi, address)
  }

  async getBlockNumber(): Promise<number> {
    const block = await this.tronWeb.trx.getCurrentBlock()
    return block.block_header.raw_data.number
  }

  public async getTxCalldata(hash: string): Promise<string> {
    const tx = await this.tronWeb.trx.getTransaction(hash)
    return '0x' + tx.raw_data.contract[0].parameter.value.data
  }
}
