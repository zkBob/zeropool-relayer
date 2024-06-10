import { buildNetworkBackend, buildProver, buildTxManager } from '@/common/serviceUtils'
import config from '@/configs/commitmentWatcherConfig'
import { logger } from '@/lib/appLogger'
import { redis } from '@/lib/redisClient'
import { FinalizerPool, PendingCommitment } from '@/pool/FinalizerPool'
import { Circuit, ProverType } from '@/prover'
import { JobState, poolTxQueue, WorkerTxType } from '@/queue/poolTxQueue'
import { ZERO_ADDRESS } from '@/utils/constants'
import { createDirectDepositWorker } from '@/workers/directDepositWorker'
import { createPoolTxWorker } from '@/workers/poolTxWorker'
import { createSentTxWorker } from '@/workers/sentTxWorker'
import { IWorkerBaseConfig } from '@/workers/workerTypes'
import { Mutex } from 'async-mutex'
import BN from 'bn.js'
import { toBN } from 'web3-utils'

async function processCommitment(pendingCommitment: PendingCommitment) {
  const { timestamp, privilegedProver, fee, commitment, gracePeriodEnd } = pendingCommitment

  const currentTimestamp = new BN(Math.floor(Date.now() / 1000))
  const isEligible =
    privilegedProver === ZERO_ADDRESS ||
    privilegedProver === config.txManager.TX_ADDRESS ||
    currentTimestamp.gte(toBN(gracePeriodEnd))
  if (!isEligible) {
    logger.info('Not allowed to submit the proof yet, waiting...')
    return
  }

  if (await poolTxQueue.getJob(commitment)) {
    logger.info('Job already created, waiting...', { commitment })
    return
  }

  const job = await poolTxQueue.add(
    'tx',
    {
      type: WorkerTxType.Finalize,
      transaction: {
        txHash: null,
        state: JobState.WAITING,
        outCommit: commitment,
        privilegedProver,
        fee,
        timestamp,
        gracePeriodEnd,
      },
    },
    {
      jobId: commitment,
    }
  )
  logger.debug(`Added poolTxWorker job: ${job.id}`)
}

async function runWatcher(pool: FinalizerPool) {
  try {
    const pendingCommitment = await pool.fetchCommitment()
    if (pendingCommitment) {
      await processCommitment(pendingCommitment)
    }
  } catch (e) {
    logger.error(e)
  }

  setTimeout(() => {
    runWatcher(pool)
  }, config.COMMITMENT_WATCHER_FETCH_INTERVAL)
}

export async function init() {
  const networkBackend = buildNetworkBackend(config.base, config.network, config.COMMITMENT_WATCHER_TOKEN_ADDRESS)
  const txManager = buildTxManager(redis, networkBackend, config.gasPrice, config.txManager)

  const pool = new FinalizerPool(networkBackend, {
    statePath: config.COMMITMENT_WATCHER_STATE_DIR_PATH,
    txVkPath: config.COMMITMENT_WATCHER_TX_VK_PATH,
    eventsBatchSize: config.base.COMMON_EVENTS_PROCESSING_BATCH_SIZE,
  })
  const treeProver = buildProver(
    Circuit.Tree,
    ProverType.Local,
    config.COMMITMENT_WATCHER_TREE_UPDATE_PARAMS_PATH as string
  )

  const directDepositProver = buildProver(
    Circuit.DirectDeposit,
    ProverType.Local,
    config.COMMITMENT_WATCHER_DIRECT_DEPOSIT_PARAMS_PATH as string
  )

  if (!config.base.COMMON_INDEXER_URL) {
    throw new Error('COMMON_INDEXER_URL is not set')
  }

  await pool.init(treeProver, directDepositProver, config.base.COMMON_INDEXER_URL)
  await txManager.init()

  const workerBaseConfig: IWorkerBaseConfig = {
    pool,
    redis,
  }

  const mutex = new Mutex()

  const workerPromises = [
    createPoolTxWorker({
      ...workerBaseConfig,
      mutex,
      txManager,
    }),
    createSentTxWorker({
      ...workerBaseConfig,
      mutex,
      txManager,
    }),
    createDirectDepositWorker({
      ...workerBaseConfig,
    }),
  ]

  const workers = await Promise.all(workerPromises)
  workers.forEach(w => w.run())

  runWatcher(pool)
}
