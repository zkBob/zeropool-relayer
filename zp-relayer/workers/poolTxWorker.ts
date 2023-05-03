import type { Logger } from 'winston'
import { Job, Worker } from 'bullmq'
import { toBN } from 'web3-utils'
import { web3 } from '@/services/web3'
import { logger } from '@/services/appLogger'
import { poolTxQueue, BatchTx, PoolTxResult, WorkerTx, WorkerTxType } from '@/queue/poolTxQueue'
import { TX_QUEUE_NAME } from '@/utils/constants'
import { buildPrefixedMemo, waitForFunds, withErrorLog, withMutex } from '@/utils/helpers'
import { pool } from '@/pool'
import { sentTxQueue } from '@/queue/sentTxQueue'
import { buildDirectDeposits, ProcessResult, buildTx } from '@/txProcessor'
import config from '@/configs/relayerConfig'
import { getMaxRequiredGasPrice } from '@/services/gas-price'
import { isInsufficientBalanceError } from '@/utils/web3Errors'
import { TxValidationError } from '@/validation/tx/common'
import type { IPoolWorkerConfig } from './workerTypes'

interface HandlerConfig<T extends WorkerTxType> {
  type: T
  tx: WorkerTx<T>
  processResult: ProcessResult
  logger: Logger
  traceId?: string
  jobId: string
}

export async function createPoolTxWorker({
  redis,
  mutex,
  txManager,
  validateTx,
  treeProver,
  feeManager,
}: IPoolWorkerConfig) {
  const workerLogger = logger.child({ worker: 'pool' })
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  async function handleTx<T extends WorkerTxType>({
    type,
    tx,
    processResult,
    logger,
    traceId,
    jobId,
  }: HandlerConfig<T>): Promise<[string, string]> {
    const { data, outCommit, commitIndex, memo, rootAfter, nullifier } = processResult

    const gas = config.relayerGasLimit
    const { txHash, rawTransaction, gasPrice, txConfig } = await txManager.prepareTx(
      {
        data,
        gas: gas.toString(),
        to: config.poolAddress,
      },
      // XXX: Assumed that gasPrice was updated during fee validation
      { shouldUpdateGasPrice: false }
    )
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
        txPayload: { transactions: tx, traceId, type },
        prevAttempts: [[txHash, gasPrice]],
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

    const { transactions: txs, traceId, type } = job.data

    const jobLogger = workerLogger.child({ jobId: job.id, traceId })
    jobLogger.info('Processing...')
    jobLogger.info('Received %s txs', txs.length)

    const txHashes: [string, string][] = []

    const baseConfig = {
      logger: jobLogger,
      traceId,
      type,
      jobId: job.id as string,
    }
    let handlerConfig: HandlerConfig<WorkerTxType>

    for (const payload of txs) {
      let processResult: ProcessResult
      if (type === WorkerTxType.DirectDeposit) {
        const tx = payload as WorkerTx<WorkerTxType.DirectDeposit>
        jobLogger.info('Received direct deposit', { number: txs.length })

        if (tx.deposits.length === 0) {
          logger.warn('Empty direct deposit batch, skipping')
          continue
        }

        processResult = await buildDirectDeposits(tx, treeProver, pool.optimisticState)
      } else if (type === WorkerTxType.Normal) {
        const tx = payload as WorkerTx<WorkerTxType.Normal>

        const requiredFee = await feeManager.estimateFee({
          gasLimit: config.relayerGasLimit,
        })
        const denominatedFee = requiredFee.denominate(pool.denominator).getEstimate()

        await validateTx(tx, pool, denominatedFee, traceId)

        processResult = await buildTx(tx, treeProver, pool.optimisticState)
      } else {
        throw new Error(`Unknown tx type: ${type}`)
      }

      handlerConfig = {
        ...baseConfig,
        tx: payload,
        processResult,
      }

      const res = await handleTx(handlerConfig)
      txHashes.push(res)
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
