import { Job, Queue, Worker } from 'bullmq'
import { web3 } from '@/services/web3'
import { logger } from '@/services/appLogger'
import { OUTPLUSONE, SENT_TX_QUEUE_NAME } from '@/utils/constants'
import { pool } from '@/pool'
import { SentTxPayload, sentTxQueue } from '@/queue/sentTxQueue'
import { redis } from '@/services/redisClient'
import type { GasPrice, EstimationType, GasPriceValue } from '@/services/gas-price'
import type { TransactionConfig } from 'web3-core'
import type { Mutex } from 'async-mutex'
import { withMutex } from '@/utils/helpers'
import config from '@/config'

const token = 'RELAYER'

const WORKER_OPTIONS = {
  autorun: false,
  connection: redis,
  concurrency: 1,
}

const REVERTED_SET = 'reverted'

async function markFailed(ids: string[]) {
  if (ids.length === 0) return
  await redis.sadd(REVERTED_SET, ids)
}

async function checkMarked(id: string) {
  const inSet = await redis.sismember(REVERTED_SET, id)
  return Boolean(inSet)
}

function updateTxGasPrice(txConfig: TransactionConfig, newGasPrice: GasPriceValue) {
  const newTxConfig = {
    ...txConfig,
    ...newGasPrice,
  }
  return newTxConfig
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

export async function createSentTxWorker<T extends EstimationType>(gasPrice: GasPrice<T>, mutex: Mutex) {
  const sentTxWorkerProcessor = async (job: Job<SentTxPayload>) => {
    const logPrefix = `SENT WORKER: Job ${job.id}:`
    logger.info('%s processing...', logPrefix)

    if (await checkMarked(job.id as string)) {
      logger.info('%s marked as failed, skipping', logPrefix)
      return null
    }

    const { txHash, txData, commitIndex, outCommit, nullifier, root } = job.data

    const tx = await web3.eth.getTransactionReceipt(txHash)
    if (tx) {
      // Tx mined
      if (tx.status) {
        // Successful
        logger.debug('%s Transaction %s was successfully mined at block %s', logPrefix, txHash, tx.blockNumber)

        pool.state.updateState(commitIndex, outCommit, txData)

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

        return txHash
      } else {
        // Revert
        logger.error('%s Transaction %s reverted at block %s', logPrefix, txHash, tx.blockNumber)

        // TODO: a more efficient strategy would be to collect all other jobs
        // and move them to 'failed' state as we know they will be reverted
        // To do this we need to acquire a lock for each job. Did not find
        // an easy way to do that yet. See 'collectBatch'
        const jobs = await sentTxQueue.getJobs(['delayed', 'waiting'])
        const ids = jobs.map(j => j.id as string)
        logger.info('%s marking ids %j as failed', logPrefix, ids)
        await markFailed(ids)

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
    } else {
      const txConfig = job.data.txConfig

      const oldGasPrice = txConfig.gasPrice
      const newGasPrice = gasPrice.getPrice()

      logger.warn('Tx %s is not mined; updating gasPrice: %o -> %o', txHash, oldGasPrice, newGasPrice)

      const newTxConfig = updateTxGasPrice(txConfig, newGasPrice)

      const newJobData = {
        ...job.data,
        txConfig: newTxConfig,
      }

      await sentTxQueue.add(txHash, newJobData, {
        priority: txConfig.nonce,
        delay: config.sentTxDelay,
      })
    }
  }
  const sentTxWorker = new Worker<SentTxPayload>(
    SENT_TX_QUEUE_NAME,
    job => withMutex(mutex, () => sentTxWorkerProcessor(job)),
    WORKER_OPTIONS
  )

  sentTxWorker.on('error', e => {
    logger.info('SENT_WORKER ERR: %o', e)
  })

  return sentTxWorker
}
