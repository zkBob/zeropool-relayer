// @ts-ignore
import TronWeb from 'tronweb'
import { INetworkContract } from '../types'

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
