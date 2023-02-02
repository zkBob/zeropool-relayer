// Reference implementation:
// https://github.com/omni/tokenbridge/blob/master/oracle/src/watcher.js
import type { AbiItem } from 'web3-utils'
import { web3 } from '@/services/web3'
import PoolAbi from '@/abi/pool-abi.json'
import config from '@/configs/watcherConfig'
import { logger } from '@/services/appLogger'
import { redis } from '@/services/redisClient'
import { DirectDeposit, poolTxQueue } from '@/queue/poolTxQueue'
import { contractCallRetry } from '@/utils/helpers'

import {
  lastProcessedNonce,
  getLastProcessedNonce,
  updateLastProcessedNonce,
  validateDirectDepositEvent,
} from './utils'
import { BatchCache } from './BatchCache'

const PoolInstance = new web3.eth.Contract(PoolAbi as AbiItem[], config.poolAddress)

const batch = new BatchCache<DirectDeposit>(
  config.directDepositBatchSize,
  config.directDepositBatchTtl,
  ds => {
    logger.info('Adding direct-deposit events to queue', { count: ds.length })
    poolTxQueue.add('', { transactions: [ds] }, {})
  },
  redis
)

async function init() {
  try {
    await getLastProcessedNonce()
    runWatcher()
  } catch (e) {
    logger.error(e)
    process.exit(1)
  }
}

async function getLastNonceToProcess() {
  const lastNonce = await PoolInstance.methods.directDepositNonce().call()
  return lastNonce
}

async function watch() {
  const lastNonceToProcess = await getLastNonceToProcess()

  if (lastNonceToProcess <= lastProcessedNonce) {
    logger.debug('All deposits are already processed')
    return
  }

  const directDeposits: [number, DirectDeposit][] = []
  for (let nonce = lastProcessedNonce + 1; nonce <= lastNonceToProcess; nonce++) {
    const dd = await contractCallRetry(PoolInstance, 'directDeposits', [nonce])
    if (validateDirectDepositEvent(dd)) {
      directDeposits.push([nonce, dd])
    }
  }

  await batch.add(directDeposits)

  logger.debug('Updating last processed block', { lastProcessedNonce: lastNonceToProcess.toString() })
  await updateLastProcessedNonce(lastNonceToProcess)
}

async function runWatcher() {
  await watch()

  setTimeout(() => {
    runWatcher()
  }, config.eventPollingInterval)
}

init()
