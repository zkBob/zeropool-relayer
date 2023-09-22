import { toBN } from 'web3-utils'
import { Job, Worker } from 'bullmq'
import { logger } from '@/services/appLogger'
import { contractCallRetry, withErrorLog } from '@/utils/helpers'
import { FORCED_EXIT_QUEUE_NAME } from '@/utils/constants'
import type { IForcedExitWorkerConfig } from './workerTypes'
import { ForcedExitPayload } from '@/queue/forcedExitQueue'
import { pool } from '@/pool'

export async function createForcedExitWorker({ redis }: IForcedExitWorkerConfig) {
  const workerLogger = logger.child({ worker: 'forced-exit' })
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  const forcedExitWorkerProcessor = async (job: Job<ForcedExitPayload>) => {
    const jobLogger = workerLogger.child({ jobId: job.id })

    const nullifier = job.data.nullifier

    const isPresent = await contractCallRetry(pool.PoolInstance, 'nullifiers', [nullifier]).then(toBN)
    if (isPresent.isZero()) {
      jobLogger.info('User has not finalized forced exit, removing it', { nullifier })
      await pool.state.nullifiers.remove([nullifier])
    } else {
      jobLogger.info('User successfully finalized forced exit', { nullifier })
    }
    return
  }

  const forcedExitWorker = new Worker<ForcedExitPayload>(
    FORCED_EXIT_QUEUE_NAME,
    job => withErrorLog(() => forcedExitWorkerProcessor(job)),
    WORKER_OPTIONS
  )

  forcedExitWorker.on('error', e => {
    workerLogger.info('DIRECT-DEPOSIT_WORKER ERR: %o', e)
  })

  return forcedExitWorker
}
