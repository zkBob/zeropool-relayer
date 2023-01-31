import type Redis from 'ioredis'
import { toBN } from 'web3-utils'
import type { TransactionReceipt, TransactionConfig } from 'web3-core'
import { Job, Worker } from 'bullmq'
import config from '@/configs/relayerConfig'
import { pool } from '@/pool'
import { web3 } from '@/services/web3'
import { logger } from '@/services/appLogger'
import { getMaxRequiredGasPrice } from '@/services/gas-price'
import { buildPrefixedMemo, withErrorLog, withLoop, withMutex } from '@/utils/helpers'
import { OUTPLUSONE, SENT_TX_QUEUE_NAME } from '@/utils/constants'
import { isGasPriceError, isInsufficientBalanceError, isNonceError, isSameTransactionError } from '@/utils/web3Errors'
import { SendAttempt, SentTxPayload, sentTxQueue, SentTxResult, SentTxState } from '@/queue/sentTxQueue'
import { poolTxQueue } from '@/queue/poolTxQueue'
import { getNonce } from '@/utils/web3'
import type { ISentWorkerConfig } from './workerTypes'
import type { TxManager } from '@/tx/TxManager'

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

async function clearOptimisticState() {
  logger.info('Rollback optimistic state...')
  pool.optimisticState.rollbackTo(pool.state)
  logger.info('Clearing optimistic nullifiers...')
  await pool.optimisticState.nullifiers.clear()

  const root1 = pool.state.getMerkleRoot()
  const root2 = pool.optimisticState.getMerkleRoot()
  logger.info(`Assert roots are equal: ${root1}, ${root2}, ${root1 === root2}`)
}

async function handleMined(
  { transactionHash, blockNumber }: TransactionReceipt,
  { outCommit, commitIndex, nullifier, truncatedMemo, root }: SentTxPayload,
  jobLogger = logger
): Promise<SentTxResult> {
  // Successful
  jobLogger.info('Transaction was successfully mined', { transactionHash, blockNumber })

  const prefixedMemo = buildPrefixedMemo(outCommit, transactionHash, truncatedMemo)
  pool.state.updateState(commitIndex, outCommit, prefixedMemo)
  // Update tx hash in optimistic state tx db
  pool.optimisticState.addTx(commitIndex * OUTPLUSONE, Buffer.from(prefixedMemo, 'hex'))

  // Add nullifier to confirmed state and remove from optimistic one
  if (nullifier) {
    jobLogger.info('Adding nullifier %s to PS', nullifier)
    await pool.state.nullifiers.add([nullifier])
    jobLogger.info('Removing nullifier %s from OS', nullifier)
    await pool.optimisticState.nullifiers.remove([nullifier])
  }

  const node1 = pool.state.getCommitment(commitIndex)
  const node2 = pool.optimisticState.getCommitment(commitIndex)
  jobLogger.info('Assert commitments are equal: %s, %s', node1, node2)
  if (node1 !== node2) {
    jobLogger.error('Commitments are not equal')
  }

  const rootConfirmed = pool.state.getMerkleRoot()
  jobLogger.info('Assert roots are equal')
  if (rootConfirmed !== root) {
    // TODO: Should be impossible but in such case
    // we should recover from some checkpoint
    jobLogger.error('Roots are not equal: %s should be %s', rootConfirmed, root)
  }

  return [SentTxState.MINED, transactionHash, []] as SentTxResult
}

async function handleReverted(
  { transactionHash: txHash, blockNumber }: TransactionReceipt,
  jobId: string,
  redis: Redis,
  jobLogger = logger
): Promise<SentTxResult> {
  jobLogger.error('Transaction reverted', { txHash, blockNumber })

  // Means that rollback was done previously, no need to do it now
  if (await checkMarked(redis, jobId)) {
    jobLogger.info('Job marked as failed, skipping')
    return [SentTxState.REVERT, txHash, []] as SentTxResult
  }

  await clearOptimisticState()

  // Send all jobs to re-process
  // Validation of these jobs will be done in `poolTxWorker`
  const waitingJobIds = []
  const reschedulePromises = []
  const newPoolJobIdMapping: Record<string, string> = {}
  const waitingJobs = await sentTxQueue.getJobs(['delayed', 'waiting'])
  for (let wj of waitingJobs) {
    // One of the jobs can be undefined, so we need to check it
    // https://github.com/taskforcesh/bullmq/blob/master/src/commands/addJob-8.lua#L142-L143
    if (!wj?.id) continue
    waitingJobIds.push(wj.id)

    const { txPayload, traceId } = wj.data
    let reschedulePromise: Promise<any>

    const transactions = [txPayload]
    reschedulePromise = poolTxQueue.add(txHash, { transactions, traceId })

    // To not mess up traceId we add each transaction separately
    reschedulePromises.push(
      reschedulePromise.then(j => {
        const newPoolJobId = j.id as string
        newPoolJobIdMapping[wj.data.poolJobId] = newPoolJobId
        return newPoolJobId
      })
    )
  }
  jobLogger.info('Marking ids %j as failed', waitingJobIds)
  await markFailed(redis, waitingJobIds)
  jobLogger.info('Rescheduling %d jobs to process...', waitingJobs.length)
  const rescheduledIds = await Promise.all(reschedulePromises)
  jobLogger.info('Update pool job id mapping %j ...', newPoolJobIdMapping)
  await pool.state.jobIdsMapping.add(newPoolJobIdMapping)

  return [SentTxState.REVERT, txHash, rescheduledIds] as SentTxResult
}

async function handleResend(
  txConfig: TransactionConfig,
  txManager: TxManager,
  job: Job<SentTxPayload>,
  jobLogger = logger
) {
  const [lastHash, lastGasPrice] = job.data.prevAttempts.at(-1) as SendAttempt
  jobLogger.warn('Tx %s is not mined, resending', lastHash)

  const {
    txConfig: newTxConfig,
    gasPrice,
    txHash,
    rawTransaction,
  } = await txManager.prepareTx(txConfig, jobLogger, true)

  job.data.prevAttempts.push([txHash, gasPrice])
  jobLogger.info('Re-send tx', { txHash })
  try {
    await txManager.sendTransaction(rawTransaction)
  } catch (e) {
    const err = e as Error
    jobLogger.warn('Tx resend failed', { error: err.message, txHash })
    if (isGasPriceError(err) || isSameTransactionError(err)) {
      // Tx wasn't sent successfully, but still update last attempt's
      // gasPrice to be accounted in the next iteration
      await job.update({
        ...job.data,
      })
    } else if (isInsufficientBalanceError(err)) {
      // We don't want to take into account last gasPrice increase
      job.data.prevAttempts.at(-1)![1] = lastGasPrice

      const minimumBalance = toBN(txConfig.gas!).mul(toBN(getMaxRequiredGasPrice(gasPrice)))
      jobLogger.error('Insufficient balance, waiting for funds', { minimumBalance: minimumBalance.toString(10) })
    } else if (isNonceError(err)) {
      jobLogger.warn('Nonce error', { error: err.message, txHash })
      // Throw suppressed error to be treated as a warning
      throw new Error(RECHECK_ERROR)
    }
    // Error should be caught by `withLoop` to re-run job
    throw e
  }

  // Overwrite old tx recorded in optimistic state db with new tx hash
  const { truncatedMemo, outCommit, commitIndex } = job.data
  const prefixedMemo = buildPrefixedMemo(outCommit, txHash, truncatedMemo)
  pool.optimisticState.addTx(commitIndex * OUTPLUSONE, Buffer.from(prefixedMemo, 'hex'))

  // Update job
  await job.update({
    ...job.data,
    txConfig: newTxConfig,
  })
  await job.updateProgress({ txHash, gasPrice })
}

export async function createSentTxWorker({ redis, mutex, txManager }: ISentWorkerConfig) {
  const workerLogger = logger.child({ worker: 'sent-tx' })
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  async function checkMined(
    prevAttempts: SendAttempt[],
    txNonce: number
  ): Promise<[TransactionReceipt | null, boolean]> {
    // Transaction was not mined
    const actualNonce = await getNonce(web3, config.relayerAddress)
    logger.info('Nonce value from RPC: %d; tx nonce: %d', actualNonce, txNonce)
    if (actualNonce <= txNonce) {
      return [null, false]
    }

    let tx = null
    // Iterate in reverse order to check the latest hash first
    for (let i = prevAttempts.length - 1; i >= 0; i--) {
      const txHash = prevAttempts[i][0]
      logger.info('Verifying tx', { txHash })
      try {
        tx = await web3.eth.getTransactionReceipt(txHash)
      } catch (e) {
        logger.warn('Cannot get tx receipt; RPC response: %s', (e as Error).message, { txHash })
        // Exception should be caught by `withLoop` to re-run job
        throw e
      }
      if (tx && tx.blockNumber) return [tx, false]
    }

    // Transaction was not mined, but nonce was increased
    return [null, true]
  }

  const sentTxWorkerProcessor = async (job: Job<SentTxPayload>, resendNum: number = 1) => {
    const jobLogger = workerLogger.child({ jobId: job.id, traceId: job.data.traceId, resendNum })

    jobLogger.info('Verifying job %s', job.data.poolJobId)
    const { prevAttempts, txConfig } = job.data

    // Any thrown web3 error will re-trigger re-send loop iteration
    const [tx, shouldReprocess] = await checkMined(prevAttempts, txConfig.nonce as number)
    // Should always be defined

    if (shouldReprocess) {
      // TODO: handle this case later
      jobLogger.warn('Ambiguity detected: nonce increased but no respond that transaction was mined')
      // Error should be caught by `withLoop` to re-run job
      throw new Error(RECHECK_ERROR)
    }

    if (!tx) {
      // Resend with updated gas price
      if (resendNum > config.sentTxLogErrorThreshold) {
        jobLogger.error('Too many unsuccessful re-sends')
      }

      await handleResend(txConfig, txManager, job, jobLogger)

      // Tx re-send successful
      // Throw error to re-run job after delay and
      // check if tx was mined
      throw new Error(RECHECK_ERROR)
    }

    if (tx.status) {
      return await handleMined(tx, job.data, jobLogger)
    } else {
      return await handleReverted(tx, job.id as string, redis, jobLogger)
    }
  }

  const sentTxWorker = new Worker<SentTxPayload, SentTxResult>(
    SENT_TX_QUEUE_NAME,
    job =>
      withErrorLog(
        withLoop(
          withMutex(mutex, (i: number) => sentTxWorkerProcessor(job, i)),
          config.sentTxDelay,
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
