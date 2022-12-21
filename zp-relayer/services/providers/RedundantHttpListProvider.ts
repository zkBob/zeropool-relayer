// Reference implementation:
// https://github.com/omni/tokenbridge/blob/master/oracle/src/services/RedundantHttpListProvider.js
import promiseRetry from 'promise-retry'
import { HttpListProviderError } from './HttpListProvider'
import BaseHttpProvider, { ProviderOptions } from './BaseHttpProvider'

export default class RedundantHttpListProvider extends BaseHttpProvider {
  urls: string[]

  constructor(urls: string[], options: Partial<ProviderOptions> = {}) {
    if (!urls || !urls.length) {
      throw new TypeError(`Invalid URLs: '${urls}'`)
    }

    super(urls[0], options)
    this.urls = urls
  }

  async send(payload: any, callback: any) {
    try {
      const result = await promiseRetry(retry => this.trySend(payload).catch(retry), this.options.retry)
      callback(null, result)
    } catch (e) {
      callback(e)
    }
  }

  async trySend(payload: any) {
    try {
      return await Promise.any(this.urls.map(url => this._send(url, payload, this.options)))
    } catch (e) {
      const errors = (e as AggregateError).errors
      throw new HttpListProviderError('Request failed for all urls', errors)
    }
  }
}
