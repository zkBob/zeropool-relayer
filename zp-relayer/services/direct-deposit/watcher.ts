import DirectDepositQueueAbi from '@/abi/direct-deposit-queue-abi.json'
import { buildNetworkBackend } from '@/common/serviceUtils'
import config from '@/configs/watcherConfig'
import { logger } from '@/lib/appLogger'
import { redis } from '@/lib/redisClient'
import { directDepositQueue } from '@/queue/directDepositQueue'
import type { DirectDeposit } from '@/queue/poolTxQueue'
import { validateDirectDeposit } from '@/validation/tx/validateDirectDeposit'
import { Watcher } from '@/watcher/Watcher'
import { BatchCache } from './BatchCache'
import { parseDirectDepositEvent } from './utils'

async function init() {
  const networkBackend = buildNetworkBackend(config.base, config.network, config.RELAYER_TOKEN_ADDRESS)

  const queueAddress = await networkBackend.pool.call('direct_deposit_queue')
  const DirectDepositQueueInstance = networkBackend.contract(DirectDepositQueueAbi, queueAddress)

  const batchCache = new BatchCache<DirectDeposit>(
    config.DIRECT_DEPOSIT_BATCH_SIZE,
    config.DIRECT_DEPOSIT_BATCH_TTL,
    ds => {
      logger.info('Adding direct-deposit events to queue', { count: ds.length })
      directDepositQueue.add('', ds)
    },
    dd => validateDirectDeposit(dd, DirectDepositQueueInstance),
    redis
  )
  await batchCache.init()

  const watcher = new Watcher(networkBackend, DirectDepositQueueInstance, 'direct-deposit', {
    event: 'SubmitDirectDeposit',
    blockConfirmations: config.WATCHER_BLOCK_CONFIRMATIONS,
    startBlock: config.base.COMMON_START_BLOCK,
    eventPollingInterval: config.WATCHER_EVENT_POLLING_INTERVAL,
    batchSize: config.base.COMMON_EVENTS_PROCESSING_BATCH_SIZE,
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
