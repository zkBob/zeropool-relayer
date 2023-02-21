import fetch from 'node-fetch'
import { HttpProvider } from 'web3-core'
import type { OperationOptions } from 'retry'

export interface ProviderOptions {
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

export default abstract class BaseHttpProvider implements HttpProvider {
  options: ProviderOptions
  connected = false

  constructor(public host: string, options: Partial<ProviderOptions> = {}, private jsonRpcErrorCodes: number[] = []) {
    this.options = { ...defaultOptions, ...options }
  }

  abstract send(payload: any, callback: any): void | Promise<void>

  async _send(url: string, payload: any, options: ProviderOptions) {
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
      (this.jsonRpcErrorCodes.includes(response.error.code) || response.error.message?.includes('ancient block'))
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
