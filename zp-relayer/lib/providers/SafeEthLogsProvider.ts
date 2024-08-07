// Reference implementation:
// https://github.com/omni/tokenbridge/blob/master/oracle/src/services/SafeEthLogsProvider.js
import { HttpProvider } from 'web3-core'
import { hexToNumber, isHexStrict } from 'web3-utils'
import { logger } from '../appLogger'

export function SafeEthLogsProvider(provider: HttpProvider) {
  const oldSend = provider.send.bind(provider)
  const newSend = function (payload: any, callback: any) {
    if (payload.method === 'eth_getLogs' && isHexStrict(payload.params[0].toBlock)) {
      logger.debug('Modifying eth_getLogs request to include batch eth_blockNumber request')

      const newPayload = [payload, { jsonrpc: '2.0', id: payload.id + 1, method: 'eth_blockNumber', params: [] }]
      oldSend(newPayload as any, (err, res) => {
        if (err) {
          callback(err, null)
        } else {
          // @ts-ignore
          const rawBlockNumber = res.find(({ id }) => id === payload.id + 1)
          const blockNumber = hexToNumber(rawBlockNumber.result)
          const toBlock = hexToNumber(payload.params[0].toBlock)

          if (blockNumber < toBlock) {
            logger.warn('Returned block number is less than the specified toBlock', { toBlock, blockNumber })
            callback(new Error('block number too low'), null)
          } else {
            // @ts-ignore
            const rawLogs = res.find(({ id }) => id === payload.id)
            callback(null, rawLogs)
          }
        }
      })
    } else {
      oldSend(payload, callback)
    }
  }
  provider.send = newSend.bind(provider)
  return provider
}
