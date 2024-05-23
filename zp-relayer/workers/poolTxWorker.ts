import { logger } from '@/lib/appLogger'
import { JobState, PoolTx, WorkerTxType } from '@/queue/poolTxQueue'
import { sentTxQueue } from '@/queue/sentTxQueue'
import { TX_QUEUE_NAME } from '@/utils/constants'
import { withErrorLog, withMutex } from '@/utils/helpers'
import { TxValidationError } from '@/validation/tx/common'
import { Job, Worker } from 'bullmq'
import Redis from 'ioredis'
import type { IPoolWorkerConfig } from './workerTypes'

const REVERTED_SET = 'reverted'
const RECHECK_ERROR = 'Waiting for next check'

async function markFailed(redis: Redis, ids: string[]) {
  if (ids.length === 0) return
  await redis.sadd(REVERTED_SET, ids)
}

async function checkMarked(redis: Redis, id: string) {
  const inSet = await redis.sismember(REVERTED_SET, id)
  return Boolean(inSet)
}

export async function createPoolTxWorker({ redis, mutex, pool, txManager }: IPoolWorkerConfig) {
  const workerLogger = logger.child({ worker: 'pool' })
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  const poolTxWorkerProcessor = async (job: Job<PoolTx<WorkerTxType>>) => {
    // TODO: handle queue overflow
    const { traceId } = job.data

    const jobLogger = workerLogger.child({ jobId: job.id, traceId })
    jobLogger.info('Processing...')

    try {
      await pool.validateTx(
        job.data,
        {
          // TODO: optional checks
        },
        traceId
      )
    } catch(e) {
      job.data.transaction.state = JobState.FAILED;
      job.failedReason = (e as Error).message;
      await job.update(job.data);
      throw e;
    }

    const processResult = await pool.buildTx(job.data)
    const { data, func } = processResult

    const preparedTx = await txManager.prepareTx({
      txDesc: {
        to: pool.network.pool.address(), // TODO: mpc
        value: 0,
        data,
      },
      options: {
        func,
        // Assumed that gasPrice was updated during fee validation
        shouldUpdateGasPrice: false,
        // TODO: fee limit
      },
      extraData: {
        // TODO: abstract gas for EVM
        gas: 2000000,
      },
    })
    const sendAttempt = preparedTx[1]
    try {
      await txManager.sendPreparedTx(preparedTx)
    } catch (e) {
      logger.warn('Tx send failed; it will be re-sent later', {
        txHash: preparedTx[1].txHash,
        error: (e as Error).message,
      })
    }
    const txHash = sendAttempt.txHash
    logger.info('Tx sent', { txHash })

    await pool.onSend(processResult, txHash)

    job.data.transaction.state = JobState.SENT
    job.data.transaction.txHash = txHash
    await job.update(job.data)

    await sentTxQueue.add(txHash, {
      poolJobId: job.id as string,
      processResult,
      prevAttempts: [sendAttempt],
    })
  }

  const poolTxWorker = new Worker<PoolTx<WorkerTxType>>(
    TX_QUEUE_NAME,
    job =>
      withErrorLog(
        withMutex(mutex, () => poolTxWorkerProcessor(job)),
        [TxValidationError]
      ),
    WORKER_OPTIONS
  )

  poolTxWorker.on('error', e => {
    workerLogger.info('POOL_WORKER ERR: %o', e)
  })

  return poolTxWorker
}
