import type { Logger } from 'winston'
import { Job, Worker } from 'bullmq'
import { toBN } from 'web3-utils'
import { logger } from '@/services/appLogger'
import { poolTxQueue, PoolTx, WorkerTx, WorkerTxType, JobState } from '@/queue/poolTxQueue'
import { OUTPLUSONE, TX_QUEUE_NAME } from '@/utils/constants'
import { buildPrefixedMemo, waitForFunds, withErrorLog, withMutex } from '@/utils/helpers'
import { buildDirectDeposits, ProcessResult, buildTx } from '@/txProcessor'
import config from '@/configs/relayerConfig'
import { getMaxRequiredGasPrice } from '@/services/gas-price'
import { isInsufficientBalanceError } from '@/utils/web3Errors'
import { TxValidationError } from '@/validation/tx/common'
import type { IPoolWorkerConfig } from './workerTypes'
import { EvmTx, Network, Tx, isEthereum, isTron } from '@/services/network'
import { TronTxManager } from '@/services/network/tron/TronTxManager'
import { EvmTxManager } from '@/services/network/evm/EvmTxManager'
import { Pool } from '@/pool'
import Redis from 'ioredis'

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
  validateTx,
  treeProver,
  feeManager,
  pool,
}: IPoolWorkerConfig) {
  const workerLogger = logger.child({ worker: 'pool' })
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  async function onSend(txHash: string, jobId: string, { outCommit, memo, commitIndex }: ProcessResult) {
    const job = await poolTxQueue.getJob(jobId)
    if (!job) return

    job.data.transaction.txHash = txHash
    job.data.transaction.state = JobState.SENT
    await job.update(job.data)

    // Overwrite old tx recorded in optimistic state db with new tx hash
    const prefixedMemo = buildPrefixedMemo(outCommit, txHash, memo)
    pool.optimisticState.addTx(commitIndex * OUTPLUSONE, Buffer.from(prefixedMemo, 'hex'))
  }

  async function onRevert(txHash: string, jobId: string) {
    // pass here already sent txs' job ids in case of eth
    logger.error('Transaction reverted', { txHash })

    // Means that rollback was done previously, no need to do it now
    if (await checkMarked(redis, jobId)) {
      logger.info('Job marked as failed, skipping')
      // TODO: update job state
      return
      // return [SentTxState.REVERT, txHash, []] as SentTxResult
    }

    await pool.clearOptimisticState()

    // TODO: also re-process not sent txs for tron
    // Send all jobs to re-process
    // Validation of these jobs will be done in `poolTxWorker`
    const waitingJobIds = []
    const reschedulePromises = []
    const newPoolJobIdMapping: Record<string, string> = {}
    const waitingJobs = await poolTxQueue.getJobs(['delayed', 'waiting'])
    for (let wj of waitingJobs) {
      // One of the jobs can be undefined, we need to skip it
      // https://github.com/taskforcesh/bullmq/blob/master/src/commands/addJob-8.lua#L142-L143
      if (!wj?.id) continue
      waitingJobIds.push(wj.id)

      let reschedulePromise: Promise<any>

      reschedulePromise = poolTxQueue.add(txHash, wj.data)

      // To not mess up traceId we add each transaction separately
      reschedulePromises.push(
        reschedulePromise.then(newJob => {
          const newJobId = newJob.id as string
          newPoolJobIdMapping[wj.id as string] = newJobId
          return newJobId
        })
      )
    }

    logger.info('Marking ids %j as failed', waitingJobIds)
    await markFailed(redis, waitingJobIds)
    logger.info('Rescheduling %d jobs to process...', waitingJobs.length)
    // TODO: handle rescheduling
    const rescheduledIds = await Promise.all(reschedulePromises)
    logger.info('Update pool job id mapping %j ...', newPoolJobIdMapping)
    await pool.state.jobIdsMapping.add(newPoolJobIdMapping)
  }

  async function onIncluded(txHash: string, { outCommit, commitIndex, nullifier, memo, rootAfter }: ProcessResult) {
    // Successful
    logger.info('Transaction was successfully mined', { txHash })

    const prefixedMemo = buildPrefixedMemo(outCommit, txHash, memo)
    pool.state.updateState(commitIndex, outCommit, prefixedMemo)
    // Update tx hash in optimistic state tx db
    pool.optimisticState.addTx(commitIndex * OUTPLUSONE, Buffer.from(prefixedMemo, 'hex'))

    // Add nullifier to confirmed state and remove from optimistic one
    if (nullifier) {
      logger.info('Adding nullifier %s to PS', nullifier)
      await pool.state.nullifiers.add([nullifier])
      logger.info('Removing nullifier %s from OS', nullifier)
      await pool.optimisticState.nullifiers.remove([nullifier])
    }

    const node1 = pool.state.getCommitment(commitIndex)
    const node2 = pool.optimisticState.getCommitment(commitIndex)
    logger.info('Assert commitments are equal: %s, %s', node1, node2)
    if (node1 !== node2) {
      logger.error('Commitments are not equal')
    }

    const rootConfirmed = pool.state.getMerkleRoot()
    logger.info('Assert roots are equal')
    if (rootConfirmed !== rootAfter) {
      // TODO: Should be impossible but in such case
      // we should recover from some checkpoint
      logger.error('Roots are not equal: %s should be %s', rootConfirmed, rootAfter)
    }
  }

  async function handleTx<T extends WorkerTxType>({
    processResult,
    logger,
    jobId,
  }: HandlerConfig<T>) {
    const { data, func, outCommit, commitIndex, memo, nullifier } = processResult

    const txManager = pool.network.txManager
    if (isTron(pool.network)) {
      await (txManager as TronTxManager).sendTx({
        txDesc: {
          to: config.COMMON_POOL_ADDRESS,
          value: 0,
          data,
          func,
        },
        onSend: txHash => onSend(txHash, jobId, processResult),
        onIncluded: txHash => onIncluded(txHash, processResult),
        onRevert: txHash => onRevert(txHash, jobId),
      })
    } else if (isEthereum(pool.network)) {
      await (txManager as EvmTxManager).sendTx({
        txDesc: {
          data,
          to: config.COMMON_POOL_ADDRESS,
          gas: config.RELAYER_GAS_LIMIT.toString(),
        },
        onSend: txHash => onSend(txHash, jobId, processResult),
        onIncluded: txHash => onIncluded(txHash, processResult),
        onRevert: txHash => onRevert(txHash, jobId),
      })
    }
    
    const emptyTxHash = '0x' + '0'.repeat(64)
    const prefixedMemo = buildPrefixedMemo(outCommit, emptyTxHash, memo)

    pool.optimisticState.updateState(commitIndex, outCommit, prefixedMemo)

    if (nullifier) {
      logger.debug('Adding nullifier %s to OS', nullifier)
      await pool.optimisticState.nullifiers.add([nullifier])
    }
  }

  const poolTxWorkerProcessor = async (job: Job<PoolTx<WorkerTxType>>) => {
    // TODO: handle queue overflow
    const { transaction, traceId, type } = job.data

    const jobLogger = workerLogger.child({ jobId: job.id, traceId })
    jobLogger.info('Processing...')

    const baseConfig = {
      logger: jobLogger,
      traceId,
      type,
      jobId: job.id as string,
    }
    let handlerConfig: HandlerConfig<WorkerTxType>

    let processResult: ProcessResult
    if (type === WorkerTxType.DirectDeposit) {
      const tx = transaction as WorkerTx<WorkerTxType.DirectDeposit>
      jobLogger.info('Received direct deposit', { number: tx.deposits.length })

      if (tx.deposits.length === 0) {
        logger.warn('Empty direct deposit batch, skipping')
        return
      }

      processResult = await buildDirectDeposits(tx, treeProver, pool.optimisticState)
    } else if (type === WorkerTxType.Normal) {
      const tx = transaction as WorkerTx<WorkerTxType.Normal>

      await validateTx(tx, pool, feeManager, traceId)

      processResult = await buildTx(tx, treeProver, pool.optimisticState)
    } else {
      throw new Error(`Unknown tx type: ${type}`)
    }

    handlerConfig = {
      ...baseConfig,
      tx: transaction,
      processResult,
    }

    await handleTx(handlerConfig)
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
