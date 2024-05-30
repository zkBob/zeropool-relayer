import { logger } from '@/lib/appLogger'
import { SendError } from '@/lib/network'
import { JobState, poolTxQueue } from '@/queue/poolTxQueue'
import { SentTxPayload } from '@/queue/sentTxQueue'
import { SENT_TX_QUEUE_NAME } from '@/utils/constants'
import { withErrorLog, withLoop, withMutex } from '@/utils/helpers'
import { Job, Worker } from 'bullmq'
import type { ISentWorkerConfig } from './workerTypes'

const RECHECK_ERROR = 'Waiting for next check'

export async function createSentTxWorker({ redis, mutex, pool, txManager }: ISentWorkerConfig) {
  const workerLogger = logger.child({ worker: 'sent-tx' })
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  const sentTxWorkerProcessor = async (job: Job<SentTxPayload>, resendNum: number = 1) => {
    const jobId = job.id as string
    const jobLogger = workerLogger.child({ jobId, resendNum })

    const poolJobId = job.data.poolJobId
    jobLogger.info('Verifying job %s', poolJobId)
    const { prevAttempts, processResult } = job.data
    // Any thrown web3 error will re-trigger re-send loop iteration

    let [tx, shouldReprocess] = await txManager.confirmTx(prevAttempts.map(a => a.txHash))

    if (shouldReprocess) {
      // TODO: handle this case later
      jobLogger.warn('Ambiguity detected: nonce increased but no respond that transaction was mined')
      // Error should be caught by `withLoop` to re-run job
      throw new Error(RECHECK_ERROR)
    }

    if (!tx) {
      // Resend with updated gas price
      if (resendNum > 10) {
        jobLogger.error('Too many unsuccessful re-sends')
      }

      jobLogger.debug('Trying to resend...')
      const { attempt, error } = await txManager.resendTx(prevAttempts)
      if (attempt) {
        job.data.prevAttempts.push(attempt)
      }
      if (error) {
        if (error === SendError.GAS_PRICE_ERROR) {
          throw new Error(RECHECK_ERROR)
        } else if (error === SendError.INSUFFICIENT_BALANCE) {
          // We don't want to take into account last gasPrice increase
          job.data.prevAttempts.pop()

          // TODO: wait for top-up
          throw new Error(RECHECK_ERROR)
        } else {
          throw new Error(RECHECK_ERROR)
        }
      }

      await job.update(job.data)

      // TODO: add pool onResend logic

      // Tx re-send successful
      // Throw error to re-run job after delay and
      // check if tx was mined
      throw new Error(RECHECK_ERROR)
    }

    const txHash = tx.txHash
    const updatePoolJobState = async () => {
      const poolJob = await poolTxQueue.getJob(poolJobId)
      if (!poolJob) {
        jobLogger.error('Pool job not found', { poolJobId })
      } else {
        poolJob.data.transaction.state = JobState.COMPLETED
        poolJob.data.transaction.txHash = txHash
        await poolJob.update(poolJob.data)
      }
    }
    if (tx.success) {
      // Successful
      jobLogger.info('Transaction was successfully mined', { txHash, blockNumber: tx.blockNumber })

      await pool.onConfirmed(processResult, txHash, updatePoolJobState,poolJobId)
    } else {
      await pool.onFailed(txHash, poolJobId);
      //await updatePoolJobState()
    }
  }

  const sentTxWorker = new Worker<SentTxPayload>(
    SENT_TX_QUEUE_NAME,
    job =>
      withErrorLog(
        withLoop(
          withMutex(mutex, (i: number) => sentTxWorkerProcessor(job, i)),
          5000,
          [RECHECK_ERROR]
        )
      ),
    WORKER_OPTIONS
  )

  sentTxWorker.on('error', e => {
    workerLogger.info('SENT_WORKER ERR: %o', e)
  })

  return sentTxWorker
}
