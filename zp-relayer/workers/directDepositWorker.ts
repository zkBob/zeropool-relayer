import { Job, Worker } from 'bullmq'
import { logger } from '@/services/appLogger'
import { DirectDeposit, DirectDepositResult } from '@/queue/directDepositQueue'
import { DIRECT_DEPOSIT_QUEUE_NAME } from '@/utils/constants'
import { buildPrefixedMemo, withErrorLog, withMutex } from '@/utils/helpers'
import { pool } from '@/pool'
import { sentTxQueue } from '@/queue/sentTxQueue'
import { processDirectDeposits } from '@/txProcessor'
import config from '@/configs/relayerConfig'
import { TxValidationError, validateDirectDeposit } from '@/validateTx'
import { IDirectDepositWorkerConfig } from './workerTypes'

export async function createDirectDepositWorker({ redis, mutex, txManager }: IDirectDepositWorkerConfig) {
  const workerLogger = logger.child({ worker: 'pool' })
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  const directDepositProcessor = async (job: Job<DirectDeposit[], DirectDepositResult>) => {
    const jobLogger = workerLogger.child({ jobId: job.id })

    const directDeposits = job.data
    jobLogger.info('Received direct deposit', { number: directDeposits.length })

    const validatedDeposits: DirectDeposit[] = []
    for (const dd of directDeposits) {
      try {
        await validateDirectDeposit(dd)
        validatedDeposits.push(dd)
      } catch (e) {
        jobLogger.error('Direct deposit validation failed', {
          error: (e as Error).message,
          deposit: dd,
        })
      }
    }

    jobLogger.info('Processing direct deposits', { number: validatedDeposits.length })
    if (validatedDeposits.length === 0) {
      return ['', ''] as DirectDepositResult
    }

    const { data, outCommit, commitIndex, rootAfter } = await processDirectDeposits(validatedDeposits)

    const { txHash, rawTransaction, gasPrice, txConfig } = await txManager.prepareTx({
      data,
      gas: config.relayerGasLimit.toString(),
      to: config.poolAddress,
    })

    jobLogger.info('Sending tx', { txHash })
    try {
      await txManager.sendTransaction(rawTransaction)
    } catch (e) {
      jobLogger.error('Tx send failed; it will be re-sent later', { txHash, error: (e as Error).message })
      throw e
    }

    // TODO: what to put instead of memo (last parameter)?
    const memo = ''
    const prefixedMemo = buildPrefixedMemo(outCommit, txHash, memo)

    pool.optimisticState.updateState(commitIndex, outCommit, prefixedMemo)

    const sentJob = await sentTxQueue.add(
      txHash,
      {
        poolJobId: job.id as string,
        root: rootAfter,
        outCommit,
        commitIndex,
        truncatedMemo: memo,
        txConfig,
        txPayload: job.data,
        prevAttempts: [[txHash, gasPrice]],
      },
      {
        delay: config.sentTxDelay,
      }
    )
    jobLogger.info(`Added sentTxWorker job: ${sentJob.id}`)

    return [txHash, sentJob.id] as DirectDepositResult
  }

  const directDepositWorker = new Worker<DirectDeposit[], DirectDepositResult>(
    DIRECT_DEPOSIT_QUEUE_NAME,
    job =>
      withErrorLog(
        withMutex(mutex, () => directDepositProcessor(job)),
        [TxValidationError]
      ),
    WORKER_OPTIONS
  )

  directDepositWorker.on('error', e => {
    workerLogger.info('POOL_WORKER ERR: %o', e)
  })

  return directDepositWorker
}
