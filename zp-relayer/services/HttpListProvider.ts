// Reference implementation:
// https://github.com/omni/tokenbridge/blob/master/oracle/src/services/HttpListProvider.js
import fetch from 'node-fetch'
import promiseRetry from 'promise-retry'
import type { OperationOptions } from 'retry'
import { HttpProvider } from 'web3-core'
import { FALLBACK_RPC_URL_SWITCH_TIMEOUT } from '@/utils/constants'
import config from '@/config'
import { logger } from './appLogger'

const JSONRPC_ERROR_CODES = config.relayerJsonRpcErrorCodes

export class HttpListProviderError extends Error {
  errors: Error[]
  constructor(message: string, errors: Error[]) {
    super(message)
    this.errors = errors
  }
}

interface ProviderOptions {
  name: string
  requestTimeout: number
  retry: OperationOptions
}

const defaultOptions: ProviderOptions = {
  name: 'main',
  requestTimeout: 0,
  retry: {
    retries: 0,
  },
}

export default class HttpListProvider implements HttpProvider {
  host: string
  urls: string[]
  options: ProviderOptions
  currentIndex: number
  lastTimeUsedPrimary: number
  connected = false

  constructor(urls: string[], options: Partial<ProviderOptions> = {}) {
    if (!urls || !urls.length) {
      throw new TypeError(`Invalid URLs: '${urls}'`)
    }

    this.urls = urls
    this.options = { ...defaultOptions, ...options }
    this.currentIndex = 0
    this.lastTimeUsedPrimary = 0
    this.host = this.urls[this.currentIndex]
  }

  private updateUrlIndex(index: number) {
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
        logger.info(
          'Switching to fallback JSON-RPC URL: %s -> %s; Index: %d',
          this.urls[this.currentIndex],
          this.urls[index],
          index
        )
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
        const result = await HttpListProvider._send(url, payload, this.options)
        return [result, index]
      } catch (e) {
        errors.push(e)
      }
    }

    throw new HttpListProviderError('Request failed for all urls', errors)
  }

  static async _send(url: string, payload: any, options: ProviderOptions) {
    const rawResponse = await fetch(url, {
      headers: {
        'Content-type': 'application/json',
      },
      method: 'POST',
      body: JSON.stringify(payload),
      timeout: options.requestTimeout,
    })

    if (!rawResponse.ok) {
      throw new Error(rawResponse.statusText)
    }

    const response = await rawResponse.json()

    if (
      response.error &&
      (JSONRPC_ERROR_CODES.includes(response.error.code) || response.error.message?.includes('ancient block'))
    ) {
      throw new Error(response?.error.message)
    }
    return response
  }

  disconnect(): boolean {
    return true
  }

  supportsSubscriptions(): boolean {
    return false
  }
}
