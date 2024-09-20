import { logger } from '@/lib/appLogger'
import { FinalizerPool } from '@/pool/FinalizerPool'
import { DirectDeposit, JobState, poolTxQueue, WorkerTxType, WorkerTxTypePriority } from '@/queue/poolTxQueue'
import { DIRECT_DEPOSIT_QUEUE_NAME } from '@/utils/constants'
import { withErrorLog } from '@/utils/helpers'
import { Job, Worker } from 'bullmq'
import type { IDirectDepositWorkerConfig } from './workerTypes'

export async function createDirectDepositWorker({ redis, pool }: IDirectDepositWorkerConfig) {
  const workerLogger = logger.child({ worker: 'dd-prove' })
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    // TODO: this worker can run jobs in parallel
    // We can set higher concurrency if RemoteProver is used
    concurrency: 2,
  }

  const directDepositWorkerProcessor = async (job: Job<DirectDeposit[]>) => {
    const jobLogger = workerLogger.child({ jobId: job.id })

    const directDeposits = job.data

    jobLogger.info('Building direct deposit proof', { count: directDeposits.length })
    const { proof, memo: rawMemo, outCommit } = await (pool as FinalizerPool).getDirectDepositProof(directDeposits)

    const memo = rawMemo.toString('hex')
    const poolJob = await poolTxQueue.add(
      '',
      {
        type: WorkerTxType.DirectDeposit,
        transaction: {
          deposits: directDeposits,
          txProof: proof,
          outCommit,
          memo,
          txHash: null,
          state: JobState.WAITING,
        },
      },
      {
        priority: WorkerTxTypePriority[WorkerTxType.DirectDeposit],
      }
    )
    jobLogger.info('Added poolTx job', { id: poolJob.id })

    return [poolJob.id as string, memo] as [string, string]
  }

  const directDepositWorker = new Worker<DirectDeposit[], [string, string]>(
    DIRECT_DEPOSIT_QUEUE_NAME,
    job => withErrorLog(() => directDepositWorkerProcessor(job)),
    WORKER_OPTIONS
  )

  directDepositWorker.on('error', e => {
    workerLogger.info('DIRECT-DEPOSIT_WORKER ERR: %o', e)
  })

  return directDepositWorker
}
