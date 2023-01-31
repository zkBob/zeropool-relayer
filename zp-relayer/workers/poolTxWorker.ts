import { toBN } from 'web3-utils'
import { Job, Worker } from 'bullmq'
import { web3 } from '@/services/web3'
import { logger } from '@/services/appLogger'
import { poolTxQueue, BatchTx, PoolTxResult, DirectDeposit, TxPayload, WorkerTxType } from '@/queue/poolTxQueue'
import { TX_QUEUE_NAME } from '@/utils/constants'
import { buildPrefixedMemo, waitForFunds, withErrorLog, withMutex } from '@/utils/helpers'
import { pool } from '@/pool'
import { sentTxQueue } from '@/queue/sentTxQueue'
import { buildDirectDeposits, ProcessResult, buildTx } from '@/txProcessor'
import config from '@/configs/relayerConfig'
import { getMaxRequiredGasPrice } from '@/services/gas-price'
import { isInsufficientBalanceError } from '@/utils/web3Errors'
import { TxValidationError, validateDirectDeposit } from '@/validateTx'
import type { IPoolWorkerConfig } from './workerTypes'
import type { Logger } from 'winston'

interface HandlerConfig {
  logger: Logger
  traceId?: string
  jobId: string
}

function isDirectDeposit(tx: WorkerTxType): tx is DirectDeposit[] {
  return Array.isArray(tx) && tx.length > 0 && 'sender' in tx[0]
}

function isNormalTransaction(tx: WorkerTxType): tx is TxPayload {
  return 'amount' in tx
}

export async function createPoolTxWorker({ redis, mutex, txManager, validateTx }: IPoolWorkerConfig) {
  const workerLogger = logger.child({ worker: 'pool' })
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  async function handleTx<T extends WorkerTxType>(
    tx: T,
    processor: (tx: T) => Promise<ProcessResult>,
    { logger, traceId, jobId }: HandlerConfig
  ): Promise<[string, string]> {
    const { data, outCommit, commitIndex, memo, rootAfter, nullifier } = await processor(tx)

    const gas = config.relayerGasLimit
    const { txHash, rawTransaction, gasPrice, txConfig } = await txManager.prepareTx({
      data,
      gas: gas.toString(),
      to: config.poolAddress,
    })
    logger.info('Sending tx', { txHash })
    try {
      await txManager.sendTransaction(rawTransaction)
    } catch (e) {
      if (isInsufficientBalanceError(e as Error)) {
        const minimumBalance = gas.mul(toBN(getMaxRequiredGasPrice(gasPrice)))
        logger.error('Insufficient balance, waiting for funds', { minimumBalance: minimumBalance.toString(10) })
        await Promise.all([poolTxQueue.pause(), sentTxQueue.pause()])
        waitForFunds(
          web3,
          config.relayerAddress,
          () => Promise.all([poolTxQueue.resume(), sentTxQueue.resume()]),
          minimumBalance,
          config.insufficientBalanceCheckTimeout
        )
      }
      logger.error('Tx send failed; it will be re-sent later', { txHash, error: (e as Error).message })
    }

    const prefixedMemo = buildPrefixedMemo(outCommit, txHash, memo)

    pool.optimisticState.updateState(commitIndex, outCommit, prefixedMemo)

    if (nullifier) {
      logger.debug('Adding nullifier %s to OS', nullifier)
      await pool.optimisticState.nullifiers.add([nullifier])
    }

    const sentJob = await sentTxQueue.add(
      txHash,
      {
        poolJobId: jobId,
        root: rootAfter,
        outCommit,
        commitIndex,
        truncatedMemo: memo,
        nullifier,
        txConfig,
        txPayload: tx,
        prevAttempts: [[txHash, gasPrice]],
        traceId,
      },
      {
        delay: config.sentTxDelay,
      }
    )
    logger.info(`Added sentTxWorker job: ${sentJob.id}`)
    return [txHash, sentJob.id as string]
  }

  const poolTxWorkerProcessor = async (job: Job<BatchTx<WorkerTxType>, PoolTxResult[]>) => {
    const sentTxNum = await sentTxQueue.count()
    if (sentTxNum >= config.maxSentQueueSize) {
      throw new Error('Optimistic state overflow')
    }

    const txs = job.data.transactions
    const traceId = job.data.traceId

    const jobLogger = workerLogger.child({ jobId: job.id, traceId })
    jobLogger.info('Processing...')
    jobLogger.info('Received %s txs', txs.length)

    const txHashes: [string, string][] = []
    const handlerConfig = {
      logger: jobLogger,
      traceId,
      jobId: job.id as string,
    }
    for (const payload of txs) {
      if (isDirectDeposit(payload)) {
        jobLogger.info('Received direct deposit', { number: txs.length })

        const validatedDeposits: DirectDeposit[] = []
        for (const dd of payload) {
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
          jobLogger.warn('Empty direct deposit batch after validation')
          continue
        }

        await handleTx(validatedDeposits, buildDirectDeposits, handlerConfig)
      } else if (isNormalTransaction(payload)) {
        await validateTx(payload, pool, traceId)

        const res = await handleTx(payload, buildTx, handlerConfig)
        txHashes.push(res)
      }
    }

    return txHashes
  }

  const poolTxWorker = new Worker<BatchTx<WorkerTxType>, PoolTxResult[]>(
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
