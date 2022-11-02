import type { Mutex } from 'async-mutex'
import { toBN } from 'web3-utils'
import { Job, Queue, Worker } from 'bullmq'
import { PermittableDepositTxData, TxType } from 'zp-memo-parser'
import config from '@/config'
import { pool } from '@/pool'
import { web3 } from '@/services/web3'
import { logger } from '@/services/appLogger'
import { GasPrice, EstimationType, chooseGasPriceOptions } from '@/services/gas-price'
import { withErrorLog, withMutex } from '@/utils/helpers'
import { readNonce, updateNonce } from '@/utils/redisFields'
import { OUTPLUSONE, SENT_TX_QUEUE_NAME } from '@/utils/constants'
import { isGasPriceError, isNonceError, isSameTransactionError } from '@/utils/web3Errors'
import { SentTxPayload, sentTxQueue, SentTxResult, SentTxState } from '@/queue/sentTxQueue'
import { signAndSend } from '@/tx/signAndSend'
import { checkAssertion, checkDeadline } from '@/validateTx'
import Redis from 'ioredis'

const token = 'RELAYER'
const REVERTED_SET = 'reverted'

async function markFailed(redis: Redis, ids: string[]) {
  if (ids.length === 0) return
  await redis.sadd(REVERTED_SET, ids)
}

async function checkMarked(redis: Redis, id: string) {
  const inSet = await redis.sismember(REVERTED_SET, id)
  return Boolean(inSet)
}

async function collectBatch<T>(queue: Queue<T>) {
  const jobs = await queue.getJobs(['delayed', 'waiting'])

  await Promise.all(
    jobs.map(async j => {
      // TODO fix "Missing lock for job" error
      await j.moveToFailed(
        {
          message: 'rescheduled',
          name: 'RescheduledError',
        },
        token
      )
    })
  )

  return jobs
}

async function clearOptimisticState(redis: Redis) {
  // TODO: a more efficient strategy would be to collect all other jobs
  // and move them to 'failed' state as we know they will be reverted
  // To do this we need to acquire a lock for each job. Did not find
  // an easy way to do that yet. See 'collectBatch'

  // XXX: txs marked as failed potentially could mine
  // We should either try to resend them until we are sure
  // they have mined or try to make new replacement txs
  // with higher gasPrice
  const jobs = await sentTxQueue.getJobs(['delayed', 'waiting'])
  const ids = jobs.map(j => j.id as string)
  logger.info('Marking ids %j as failed', ids)
  await markFailed(redis, ids)

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
    const { txType, txHash, prefixedMemo, commitIndex, outCommit, nullifier, root, txData } = job.data

    // TODO: it is possible that a tx marked as failed could be stuck
    // in the mempool. Worker should either assure that it is mined
    // or try to substitute such transaction with another one
    if (await checkMarked(redis, job.id as string)) {
      logger.info('%s marked as failed, skipping', logPrefix)
      return [SentTxState.REVERT, txHash] as SentTxResult
    }

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

        return [SentTxState.MINED, txHash] as SentTxResult
      } else {
        // Revert
        logger.error('%s Transaction %s reverted at block %s', logPrefix, txHash, tx.blockNumber)

        await clearOptimisticState(redis)
        return [SentTxState.REVERT, txHash] as SentTxResult
      }
    } else {
      // Resend with updated gas price
      const txConfig = job.data.txConfig

      const oldGasPrice = job.data.gasPriceOptions
      const fetchedGasPrice = gasPrice.getPrice()

      const newGasPrice = chooseGasPriceOptions(oldGasPrice, fetchedGasPrice)

      logger.warn('Tx %s is not mined; updating gasPrice: %o -> %o', txHash, oldGasPrice, newGasPrice)

      const newTxConfig = {
        ...txConfig,
        ...newGasPrice,
      }

      try {
        if (txType === TxType.PERMITTABLE_DEPOSIT) {
          const deadline = (txData as PermittableDepositTxData).deadline
          await checkAssertion(() => checkDeadline(toBN(deadline), config.permitDeadlineThresholdResend))
        }

        const newTxHash = await signAndSend(newTxConfig, config.relayerPrivateKey, web3)

        // Add updated job
        await sentTxQueue.add(
          newTxHash,
          {
            ...job.data,
            txHash: newTxHash,
            txConfig: newTxConfig,
            gasPriceOptions: newGasPrice,
          },
          {
            priority: txConfig.nonce,
            delay: config.sentTxDelay,
          }
        )
        return [SentTxState.RESEND, newTxHash] as SentTxResult
      } catch (e) {
        const err = e as Error
        logger.warn('%s: Tx resend failed for %s: %s', logPrefix, txHash, err.message)
        if (isSameTransactionError(err) || isGasPriceError(err)) {
          // Force update gas price
          gasPrice.start()
        } else if (isNonceError(err)) {
          await updateNonce(await readNonce(true))
        } else {
          // Error can't be handled
          logger.error('%s: Error cannot be handled: %o', logPrefix, err)
          // Rollback the tree
          await clearOptimisticState(redis)
          return [SentTxState.FAILED, txHash] as SentTxResult
        }

        // Add same job
        await sentTxQueue.add(txHash, job.data, {
          priority: txConfig.nonce,
          delay: config.sentTxDelay,
        })
        return [SentTxState.RESEND, txHash] as SentTxResult
      }
    }
  }
  const sentTxWorker = new Worker<SentTxPayload, SentTxResult>(
    SENT_TX_QUEUE_NAME,
    job => withErrorLog(withMutex(mutex, () => sentTxWorkerProcessor(job))),
    WORKER_OPTIONS
  )

  sentTxWorker.on('error', e => {
    logger.info('SENT_WORKER ERR: %o', e)
  })

  return sentTxWorker
}
