import type { Mutex } from 'async-mutex'
import { Job, Worker } from 'bullmq'
import config from '@/config'
import { pool } from '@/pool'
import { web3 } from '@/services/web3'
import { logger } from '@/services/appLogger'
import { GasPrice, EstimationType, chooseGasPriceOptions, addExtraGasPrice } from '@/services/gas-price'
import { withErrorLog, withLoop, withMutex } from '@/utils/helpers'
import { readNonce, updateNonce } from '@/utils/redisFields'
import { OUTPLUSONE, SENT_TX_QUEUE_NAME } from '@/utils/constants'
import { isNonceError } from '@/utils/web3Errors'
import { SentTxPayload, sentTxQueue, SentTxResult, SentTxState } from '@/queue/sentTxQueue'
import { signAndSend } from '@/tx/signAndSend'
import Redis from 'ioredis'
import { poolTxQueue } from '@/queue/poolTxQueue'

const REVERTED_SET = 'reverted'

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
  logger.info('Clearing optimistic roots...')
  await pool.optimisticState.roots.clear()

  const root1 = pool.state.getMerkleRoot()
  const root2 = pool.optimisticState.getMerkleRoot()
  logger.info(`Assert roots are equal: ${root1}, ${root2}, ${root1 === root2}`)
}

export async function createSentTxWorker<T extends EstimationType>(gasPrice: GasPrice<T>, mutex: Mutex, redis: Redis) {
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  const sentTxWorkerProcessor = async (job: Job<SentTxPayload>) => {
    const logPrefix = `SENT WORKER: Job ${job.id}:`
    logger.info('%s processing...', logPrefix)
    const { txHash, prefixedMemo, commitIndex, outCommit, nullifier, root } = job.data

    const tx = await web3.eth.getTransactionReceipt(txHash)
    if (tx) {
      // Tx mined
      if (tx.status) {
        // Successful
        logger.debug('%s Transaction %s was successfully mined at block %s', logPrefix, txHash, tx.blockNumber)

        pool.state.updateState(commitIndex, outCommit, prefixedMemo)

        // Add nullifer to confirmed state and remove from optimistic one
        logger.info('Adding nullifier %s to PS', nullifier)
        await pool.state.nullifiers.add([nullifier])
        logger.info('Removing nullifier %s from OS', nullifier)
        await pool.optimisticState.nullifiers.remove([nullifier])

        // Add root to confirmed state and remove from optimistic one
        const poolIndex = ((commitIndex + 1) * OUTPLUSONE).toString(10)
        logger.info('Adding root %s %s to PS', poolIndex, root)
        await pool.state.roots.add({ [poolIndex]: root })
        logger.info('Removing root %s %s from OS', poolIndex, root)
        await pool.optimisticState.roots.remove([poolIndex])

        const node1 = pool.state.getCommitment(commitIndex)
        const node2 = pool.optimisticState.getCommitment(commitIndex)
        logger.info(`Assert commitments are equal: ${node1}, ${node2}`)
        if (node1 !== node2) {
          logger.error('Commitments are not equal')
        }

        return [SentTxState.MINED, txHash, []] as SentTxResult
      } else {
        // Revert
        logger.error('%s Transaction %s reverted at block %s', logPrefix, txHash, tx.blockNumber)

        // Means that rollback was done previously, no need to do it now
        if (await checkMarked(redis, job.id as string)) {
          logger.info('%s Job %s marked as failed, skipping', logPrefix, job.id)
          return [SentTxState.REVERT, txHash, []] as SentTxResult
        }

        await clearOptimisticState()

        // Send all jobs to re-process
        // Validation of these jobs will be done in `poolTxWorker`
        const waitingJobIds = []
        const reschedulePromises = []
        const waitingJobs = await sentTxQueue.getJobs(['delayed', 'waiting'])
        for (let wj of waitingJobs) {
          // One of the jobs can be undefined, so we need to check it
          // https://github.com/taskforcesh/bullmq/blob/master/src/commands/addJob-8.lua#L142-L143
          if (!wj?.id) continue
          waitingJobIds.push(wj.id)
          reschedulePromises.push(poolTxQueue.add(txHash, [wj.data.txPayload]).then(j => j.id as string))
        }
        logger.info('Marking ids %j as failed', waitingJobIds)
        await markFailed(redis, waitingJobIds)
        logger.info('%s Rescheduling %d jobs to process...', logPrefix, waitingJobs.length)
        const rescheduledIds = await Promise.all(reschedulePromises)

        return [SentTxState.REVERT, txHash, rescheduledIds] as SentTxResult
      }
    } else {
      // Resend with updated gas price
      const txConfig = job.data.txConfig

      const oldGasPrice = job.data.gasPriceOptions

      const fetchedGasPrice = await gasPrice.fetchOnce()
      const oldWithExtra = addExtraGasPrice(oldGasPrice, config.minGasPriceBumpFactor, null)
      const newWithExtra = addExtraGasPrice(fetchedGasPrice, config.gasPriceSurplus, null)

      const newGasPrice = chooseGasPriceOptions(oldWithExtra, newWithExtra)

      logger.warn('%s Tx %s is not mined; updating gasPrice: %o -> %o', logPrefix, txHash, oldGasPrice, newGasPrice)

      const newTxConfig = {
        ...txConfig,
        ...newGasPrice,
      }

      try {
        const newTxHash = await signAndSend(newTxConfig, config.relayerPrivateKey, web3)
        // Update job
        await job.update({
          ...job.data,
          txHash: newTxHash,
          txConfig: newTxConfig,
          gasPriceOptions: newGasPrice,
        })
        await job.updateProgress({ txHash: newTxHash, gasPrice: newGasPrice })
      } catch (e) {
        const err = e as Error
        logger.warn('%s Tx resend failed for %s: %s', logPrefix, txHash, err.message)
        // TODO: Should we handle other tx sending errors here?
        if (isNonceError(err)) {
          await updateNonce(await readNonce(true))
        }
        // Error should be caught by `withLoop` to re-run job
        throw e
      }
      // Tx re-send successful
      // Throw error to re-run job after delay and
      // check if tx was mined
      throw new Error('Waiting for next check')
    }
  }
  const sentTxWorker = new Worker<SentTxPayload, SentTxResult>(
    SENT_TX_QUEUE_NAME,
    job =>
      withErrorLog(
        withLoop(
          withMutex(mutex, () => sentTxWorkerProcessor(job)),
          config.sentTxDelay
        )
      ),
    WORKER_OPTIONS
  )

  sentTxWorker.on('error', e => {
    logger.info('SENT_WORKER ERR: %o', e)
  })

  return sentTxWorker
}
