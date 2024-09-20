import { buildNetworkBackend } from '@/common/serviceUtils'
import config from '@/configs/indexerConfig'
import { IndexerPool } from '@/pool/IndexerPool'
import { Watcher } from '@/watcher/Watcher'

export async function init() {
  const networkBackend = buildNetworkBackend(config.base, config.network, config.INDEXER_TOKEN_ADDRESS)

  const pool = new IndexerPool(networkBackend, {
    statePath: config.INDEXER_STATE_DIR_PATH,
    txVkPath: config.INDEXER_TX_VK_PATH,
    eventsBatchSize: config.base.COMMON_EVENTS_PROCESSING_BATCH_SIZE,
  })

  const lastInitialSyncBlock = await pool.getLastBlockToProcess()
  await Promise.all([networkBackend.init(), pool.init(config.base.COMMON_START_BLOCK, lastInitialSyncBlock)])

  const startBlock = lastInitialSyncBlock + 1
  const watcher = new Watcher(networkBackend, networkBackend.pool, 'pool-indexer', {
    event: 'allEvents',
    blockConfirmations: config.INDEXER_BLOCK_CONFIRMATIONS,
    startBlock,
    eventPollingInterval: parseInt(process.env.WATCHER_EVENT_POLLING_INTERVAL || '10000'),
    batchSize: config.base.COMMON_EVENTS_PROCESSING_BATCH_SIZE,
    processor: async batch => {
      for (let event of batch) {
        if (event.values.message) {
          // Message event
          await pool.addTxToState(event.txHash, event.values.index, event.values.message, 'optimistic', event.blockNumber)
        } else if (event.values.commitment) {
          // RootUpdated event
          pool.propagateOptimisticState(event.values.index, event.blockNumber)
        }
      }
    },
  })

  await watcher.init()
  watcher.run()

  return { pool }
}
