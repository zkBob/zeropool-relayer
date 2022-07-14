import { Queue, Worker } from 'bullmq'
import { web3 } from './services/web3'
import { logger } from './services/appLogger'
import { SENT_TX_QUEUE_NAME, TX_CHECK_DELAY } from './utils/constants'
import { pool } from './pool'
import { SentTxPayload, sentTxQueue } from './services/sentTxQueue'
import { redis } from './services/redisClient'
import type { GasPrice, EstimationType, GasPriceValue } from './services/GasPrice'
import type { TransactionConfig } from 'web3-core'

const token = 'RELAYER'

const WORKER_OPTIONS = {
  autorun: false,
  connection: redis,
  concurrency: 1,
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

export async function createSentTxWorker<T extends EstimationType>(gasPrice: GasPrice<T>) {
  const sentTxWorker = new Worker<SentTxPayload>(
    SENT_TX_QUEUE_NAME,
    async job => {
      const logPrefix = `SENT WORKER: Job ${job.id}:`
      logger.info('%s processing...', logPrefix)

      const { txHash, txData, commitIndex, outCommit, payload } = job.data

      const tx = await web3.eth.getTransactionReceipt(txHash)
      if (tx) {
        // Tx mined
        if (tx.status) {
          // Successful
          logger.debug('%s Transaction %s was successfully mined at block %s', logPrefix, txHash, tx.blockNumber)

          pool.state.updateState(commitIndex, outCommit, txData)

          const node1 = pool.state.getCommitment(commitIndex)
          const node2 = pool.optimisticState.getCommitment(commitIndex)
          logger.info(`Assert nodes are equal: ${node1}, ${node2}, ${node1 === node2}`)

          return txHash
        } else {
          // Revert
          logger.error('%s Transaction %s reverted at block %s', logPrefix, txHash, tx.blockNumber)

          // TODO: a more efficient strategy would be to collect all other jobs
          // and move them to 'failed' state as we know they will be reverted
          // To do this we need to acquire a lock for each job. Did not find
          // an easy way to do that yet. See 'collectBatch'

          logger.info('Rollback optimistic state...')
          pool.optimisticState.rollbackTo(pool.state)
          const root1 = pool.state.getMerkleRoot()
          const root2 = pool.optimisticState.getMerkleRoot()
          logger.info(`Assert roots are equal: ${root1}, ${root2}, ${root1 === root2}`)
        }
      } else {
        const txConfig = job.data.txConfig

        const oldGasPrice = txConfig.gasPrice
        const newGasPrice = gasPrice.getPrice()

        logger.warn('Tx unmined; updating gasPrice: %o -> %o', oldGasPrice, newGasPrice)

        const newTxConfig = updateTxGasPrice(txConfig, newGasPrice)

        const newJobData = {
          ...job.data,
          txConfig: newTxConfig,
        }

        await sentTxQueue.add(txHash, newJobData, {
          priority: txConfig.nonce,
          delay: TX_CHECK_DELAY,
        })
      }
    },
    WORKER_OPTIONS
  )

  sentTxWorker.on('error', e => {
    logger.info('SENT_WORKER ERR: %o', e)
  })

  return sentTxWorker
}
