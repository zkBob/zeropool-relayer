import DirectDepositQueueAbi from '@/abi/direct-deposit-queue-abi.json'
import config from '@/configs/watcherConfig'
import { directDepositQueue } from '@/queue/directDepositQueue'
import type { DirectDeposit } from '@/queue/poolTxQueue'
import { logger } from '@/services/appLogger'
import { EvmBackend, Network, NetworkBackend, TronBackend } from '@/services/network'
import { redis } from '@/services/redisClient'
import { validateDirectDeposit } from '@/validation/tx/validateDirectDeposit'
// @ts-ignore
import { Watcher } from '@/watcher/watcher'
import { BatchCache } from './BatchCache'
import { parseDirectDepositEvent } from './utils'

async function initNetwork() {
  let networkBackend: NetworkBackend<Network>
    // @ts-ignore
  if (config.COMMITMENT_WATCHER_NETWORK === Network.Ethereum) {
    networkBackend = new EvmBackend({} as any)
    // @ts-ignore
  } else if (config.COMMITMENT_WATCHER_NETWORK === Network.Tron) {
    networkBackend = new TronBackend({} as any)
  } else {
    throw new Error('Unsupported network backend')
  }
  return networkBackend
}

async function init() {
  const network = await initNetwork()

  const queueAddress = await network.pool.call('direct_deposit_queue')
  const DirectDepositQueueInstance = network.contract(DirectDepositQueueAbi, queueAddress)

  const batchCache = new BatchCache<DirectDeposit>(
    config.directDepositBatchSize,
    config.directDepositBatchTtl,
    ds => {
      logger.info('Adding direct-deposit events to queue', { count: ds.length })
      directDepositQueue.add('', ds)
    },
    // @ts-ignore
    dd => validateDirectDeposit(dd, DirectDepositQueueInstance),
    redis
  )
  await batchCache.init()

  const watcher = new Watcher(network, DirectDepositQueueInstance, 'direct-deposit', {
    event: 'SubmitDirectDeposit',
    blockConfirmations: config.blockConfirmations,
    startBlock: config.COMMON_START_BLOCK,
    eventPollingInterval: config.eventPollingInterval,
    batchSize: config.COMMON_EVENTS_PROCESSING_BATCH_SIZE,
    processor: async (batch: any) => {
      const directDeposits: [string, DirectDeposit][] = []
      for (let event of batch) {
        const dd = parseDirectDepositEvent(event.values)
        directDeposits.push([dd.nonce, dd])
      }

      await batchCache.add(directDeposits)
    },
  })

  await watcher.init()
  watcher.run()
}

init()
