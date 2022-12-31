// Reference implementation:
// https://github.com/omni/tokenbridge/blob/master/oracle/src/services/HttpListProvider.js
import { hexToNumber } from 'web3-utils'
import promiseRetry from 'promise-retry'
import { FALLBACK_RPC_URL_SWITCH_TIMEOUT } from '@/utils/constants'
import { logger } from '../appLogger'
import BaseHttpProvider, { ProviderOptions } from './BaseHttpProvider'

export class HttpListProviderError extends Error {
  errors: Error[]
  constructor(message: string, errors: Error[]) {
    super(message)
    this.errors = errors
  }
}

export default class HttpListProvider extends BaseHttpProvider {
  urls: string[]
  currentIndex: number
  lastTimeUsedPrimary: number
  latestBlock: number
  syncStateCheckerIntervalId?: NodeJS.Timer

  constructor(urls: string[], options: Partial<ProviderOptions> = {}) {
    if (!urls || !urls.length) {
      throw new TypeError(`Invalid URLs: '${urls}'`)
    }

    super(urls[0], options)
    this.currentIndex = 0
    this.lastTimeUsedPrimary = 0
    this.latestBlock = 0

    this.urls = urls
  }

  startSyncStateChecker(syncCheckInterval: number) {
    if (this.urls.length > 1 && syncCheckInterval > 0 && !this.syncStateCheckerIntervalId) {
      this.syncStateCheckerIntervalId = setInterval(() => this.checkLatestBlock(), syncCheckInterval)
    }
  }

  checkLatestBlock() {
    const payload = { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }
    this.send(payload, (error: any, result: any) => {
      if (error) {
        logger.warn('Failed to request latest block from all RPC urls', { oldBlock: this.latestBlock })
      } else if (result.error) {
        logger.warn('Failed to make eth_blockNumber request due to unknown error', {
          oldBlock: this.latestBlock,
          error: result.error.message,
        })
        this.updateUrlIndex()
      } else {
        const blockNumber = hexToNumber(result.result)
        const blocksLog = { oldBlock: this.latestBlock, newBlock: blockNumber }
        if (blockNumber > this.latestBlock) {
          logger.debug('Updating latest block number', blocksLog)
          this.latestBlock = blockNumber
        } else {
          logger.warn('Latest block on the node was not updated since last request', blocksLog)
          this.updateUrlIndex()
        }
      }
    })
  }

  private updateUrlIndex(index?: number) {
    const prevIndex = this.currentIndex
    if (!index) {
      index = (prevIndex + 1) % this.urls.length
    }

    if (prevIndex === index) {
      return
    }

    logger.info('Switching JSON-RPC URL: %s -> %s; Index: %d', this.urls[this.currentIndex], this.urls[index], index)

    this.currentIndex = index
    this.host = this.urls[this.currentIndex]
  }

  async send(payload: any, callback: any) {
    // if fallback URL is being used for too long, switch back to the primary URL
    if (this.currentIndex > 0 && Date.now() - this.lastTimeUsedPrimary > FALLBACK_RPC_URL_SWITCH_TIMEOUT) {
      logger.info('Switching back to the primary JSON-RPC URL: %s -> %s', this.urls[this.currentIndex], this.urls[0])
      this.updateUrlIndex(0)
    }

    // save the currentIndex to avoid race condition
    const { currentIndex } = this

    try {
      const [result, index] = await promiseRetry(
        retry => this.trySend(payload, currentIndex).catch(retry),
        this.options.retry
      )

      // if some of URLs failed to respond, current URL index is updated to the first URL that responded
      if (currentIndex !== index) {
        this.updateUrlIndex(index)
      }
      callback(null, result)
    } catch (e) {
      callback(e)
    }
  }

  private async trySend(payload: any, initialIndex: number) {
    const errors: any = []

    for (let count = 0; count < this.urls.length; count++) {
      const index = (initialIndex + count) % this.urls.length

      // when request is being sent to the primary URL, the corresponding time marker is updated
      if (index === 0) {
        this.lastTimeUsedPrimary = Date.now()
      }

      const url = this.urls[index]
      try {
        const result = await this._send(url, payload, this.options)
        return [result, index]
      } catch (e) {
        errors.push(e)
      }
    }

    throw new HttpListProviderError('Request failed for all urls', errors)
  }
}
