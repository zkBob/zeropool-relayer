// Reference implementation:
// https://github.com/omni/tokenbridge/blob/master/oracle/src/watcher.js
import Web3 from 'web3'
import type { AbiItem } from 'web3-utils'
import { getBlockNumber, getEvents } from '../utils/web3'
import { web3 } from '@/services/web3'
import { logger } from '@/services/appLogger'
import { lastProcessedBlock, getLastProcessedBlock, updateLastProcessedBlock } from './utils'

import config from '@/configs/watcherConfig'
import PoolAbi from '@/abi/pool-abi.json'
import { BatchCache } from './BatchCache'
import { directDepositQueue, DirectDeposit } from '@/queue/directDepositQueue'

const PoolInstance = new web3.eth.Contract(PoolAbi as AbiItem[], config.poolAddress)

const eventName = 'SubmitDirectDeposit'

const batch = new BatchCache<DirectDeposit>(config.directDepositBatchSize, config.directDepositBatchTtl, ds => {
  logger.info('Adding direct-deposit events to queue', { count: ds.length })
  directDepositQueue.add('', ds, {})
})

async function init() {
  try {
    await getLastProcessedBlock()
    runWatcher()
  } catch (e) {
    logger.error(e)
    process.exit(1)
  }
}

async function getLastBlockToProcess(web3: Web3) {
  const lastBlockNumber = await getBlockNumber(web3)
  return lastBlockNumber - config.blockConfirmations
}

async function watch() {
  const lastBlockToProcess = await getLastBlockToProcess(web3)

  if (lastBlockToProcess <= lastProcessedBlock) {
    logger.debug('All blocks already processed')
    return
  }

  const fromBlock = lastProcessedBlock + 1
  const rangeEndBlock = fromBlock + config.eventsProcessingBatchSize
  let toBlock = Math.min(lastBlockToProcess, rangeEndBlock)

  let events = await getEvents(PoolInstance, eventName, {
    fromBlock,
    toBlock,
  })
  logger.info(`Found ${events.length} direct-deposit events`)

  for (let event of events) {
    const dd = event.returnValues as DirectDeposit
    // TODO: Probably we can add values in bulk
    batch.add(dd)
  }

  logger.debug('Updating last processed block', { lastProcessedBlock: toBlock.toString() })
  await updateLastProcessedBlock(toBlock)
}

async function runWatcher() {
  await watch()

  setTimeout(() => {
    runWatcher()
  }, config.eventPollingInterval)
}

init()
