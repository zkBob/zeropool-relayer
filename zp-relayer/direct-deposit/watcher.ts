// Reference implementation:
// https://github.com/omni/tokenbridge/blob/master/oracle/src/watcher.js
import type Web3 from 'web3'
import type { AbiItem } from 'web3-utils'
import type { DirectDeposit } from '@/queue/poolTxQueue'
import { web3 } from '@/services/web3'
import PoolAbi from '@/abi/pool-abi.json'
import DirectDepositQueueAbi from '@/abi/direct-deposit-queue-abi.json'
import config from '@/configs/watcherConfig'
import { logger } from '@/services/appLogger'
import { redis } from '@/services/redisClient'
import { lastProcessedBlock, getLastProcessedBlock, updateLastProcessedBlock, parseDirectDepositEvent } from './utils'
import { BatchCache } from './BatchCache'
import { validateDirectDeposit } from '@/validation/tx/validateDirectDeposit'
import { getBlockNumber, getEvents } from '@/utils/web3'
import { directDepositQueue } from '@/queue/directDepositQueue'

const PoolInstance = new web3.eth.Contract(PoolAbi as AbiItem[], config.poolAddress)
const DirectDepositQueueInstance = new web3.eth.Contract(DirectDepositQueueAbi as AbiItem[])

const eventName = 'SubmitDirectDeposit'

const batch = new BatchCache<DirectDeposit>(
  config.directDepositBatchSize,
  config.directDepositBatchTtl,
  ds => {
    logger.info('Adding direct-deposit events to queue', { count: ds.length })
    directDepositQueue.add('', ds)
  },
  dd => validateDirectDeposit(dd, DirectDepositQueueInstance),
  redis
)

async function init() {
  await getLastProcessedBlock()
  await batch.init()
  const queueAddress = await PoolInstance.methods.direct_deposit_queue().call()
  DirectDepositQueueInstance.options.address = queueAddress
  runWatcher()
}

async function getLastBlockToProcess(web3: Web3) {
  const lastBlockNumber = await getBlockNumber(web3)
  return lastBlockNumber
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

  let events = await getEvents(DirectDepositQueueInstance, eventName, {
    fromBlock,
    toBlock,
  })
  logger.info(`Found ${events.length} direct-deposit events`)

  const directDeposits: [string, DirectDeposit][] = []
  for (let event of events) {
    const dd = parseDirectDepositEvent(event.returnValues)
    directDeposits.push([dd.nonce, dd])
  }

  await batch.add(directDeposits)

  logger.debug('Updating last processed block', { lastProcessedBlock: toBlock.toString() })
  await updateLastProcessedBlock(toBlock)
}

async function runWatcher() {
  try {
    await watch()
  } catch (e) {
    logger.error(e)
  }

  setTimeout(() => {
    runWatcher()
  }, config.eventPollingInterval)
}

init()
