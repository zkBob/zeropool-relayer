import Web3 from 'web3'
import type { Contract } from 'web3-eth-contract'
import { INetworkContract } from '../types'

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
