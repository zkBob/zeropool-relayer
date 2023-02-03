// Reference implementation:
// https://github.com/omni/tokenbridge/blob/master/oracle/src/watcher.js
import type Web3 from 'web3'
import type { AbiItem } from 'web3-utils'
import { web3 } from '@/services/web3'
import PoolAbi from '@/abi/pool-abi.json'
import config from '@/configs/watcherConfig'
import { logger } from '@/services/appLogger'
import { redis } from '@/services/redisClient'
import { DirectDeposit, poolTxQueue, WorkerTxType, WorkerTxTypePriority } from '@/queue/poolTxQueue'
import { lastProcessedBlock, getLastProcessedBlock, updateLastProcessedBlock, parseDirectDepositEvent } from './utils'
import { BatchCache } from './BatchCache'
import { validateDirectDeposit } from '@/validation/tx/validateDirectDeposit'
import { getBlockNumber, getEvents } from '@/utils/web3'

const PoolInstance = new web3.eth.Contract(PoolAbi as AbiItem[], config.poolAddress)

const eventName = 'SubmitDirectDeposit'

const batch = new BatchCache<DirectDeposit>(
  config.directDepositBatchSize,
  config.directDepositBatchTtl,
  ds => {
    logger.info('Adding direct-deposit events to queue', { count: ds.length })
    poolTxQueue.add(
      '',
      {
        transactions: [
          {
            deposits: ds,
          },
        ],
        type: WorkerTxType.DirectDeposit,
        // TODO: traceId
      },
      {
        priority: WorkerTxTypePriority[WorkerTxType.DirectDeposit],
      }
    )
  },
  dd => validateDirectDeposit(dd, PoolInstance),
  redis
)

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

  let events = await getEvents(PoolInstance, eventName, {
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
  await watch()

  setTimeout(() => {
    runWatcher()
  }, config.eventPollingInterval)
}

init()
