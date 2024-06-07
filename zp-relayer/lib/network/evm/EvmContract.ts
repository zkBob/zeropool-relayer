import { logger } from '@/lib/appLogger'
import { isContractCallError } from '@/utils/web3Errors'
import promiseRetry from 'promise-retry'
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
    return promiseRetry(
      async retry => {
        try {
          return await this.instance.methods[method](...args).call()
        } catch (e) {
          if (isContractCallError(e as Error)) {
            logger.warn('Retrying failed contract call', { method, args })
            retry(e)
          } else {
            logger.debug('Unknown contract call error', { method, args, error: e })
            throw e
          }
        }
      },
      {
        retries: 2,
        minTimeout: 500,
        maxTimeout: 500,
      }
    )
  }

  getEvents(event: string) {
    return this.instance.getPastEvents(event, {
      fromBlock: 0,
      toBlock: 'latest',
    })
  }
}
