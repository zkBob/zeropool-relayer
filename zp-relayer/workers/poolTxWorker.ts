import { toBN, toWei } from 'web3-utils'
import { Job, Worker } from 'bullmq'
import { web3 } from '@/services/web3'
import { logger } from '@/services/appLogger'
import { poolTxQueue, BatchTx, PoolTxResult } from '@/queue/poolTxQueue'
import { TX_QUEUE_NAME } from '@/utils/constants'
import { buildPrefixedMemo, truncateMemoTxPrefix, waitForFunds, withErrorLog, withMutex } from '@/utils/helpers'
import { pool } from '@/pool'
import { sentTxQueue } from '@/queue/sentTxQueue'
import { processTx } from '@/txProcessor'
import config from '@/config'
import { getMaxRequiredGasPrice } from '@/services/gas-price'
import { getTxProofField } from '@/utils/proofInputs'
import { isInsufficientBalanceError } from '@/utils/web3Errors'
import { TxValidationError } from '@/validateTx'
import { IPoolWorkerConfig } from './workerConfig'

export async function createPoolTxWorker({ redis, mutex, txManager, validateTx }: IPoolWorkerConfig) {
  const workerLogger = logger.child({ worker: 'pool' })
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  const poolTxWorkerProcessor = async (job: Job<BatchTx, PoolTxResult[]>) => {
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
    for (const tx of txs) {
      const { gas, amount, rawMemo, txType, txProof } = tx

      await validateTx(tx, pool, traceId)

      const { data, commitIndex, rootAfter } = await processTx(tx)

      const { txHash, rawTransaction, gasPrice, txConfig } = await txManager.prepareTx({
        data,
        value: toWei(toBN(amount)),
        gas,
        to: config.poolAddress,
      })
      jobLogger.info('Sending tx', { txHash })
      try {
        await txManager.sendTransaction(rawTransaction)
      } catch (e) {
        if (isInsufficientBalanceError(e as Error)) {
          const minimumBalance = toBN(gas).mul(toBN(getMaxRequiredGasPrice(gasPrice)))
          jobLogger.error('Insufficient balance, waiting for funds', { minimumBalance: minimumBalance.toString(10) })
          await Promise.all([poolTxQueue.pause(), sentTxQueue.pause()])
          waitForFunds(
            web3,
            config.relayerAddress,
            () => Promise.all([poolTxQueue.resume(), sentTxQueue.resume()]),
            minimumBalance,
            config.insufficientBalanceCheckTimeout
          )
        }
        jobLogger.error('Tx send failed; it will be re-sent later', { txHash, error: (e as Error).message })
      }

      const nullifier = getTxProofField(txProof, 'nullifier')
      const outCommit = getTxProofField(txProof, 'out_commit')

      const truncatedMemo = truncateMemoTxPrefix(rawMemo, txType)
      const prefixedMemo = buildPrefixedMemo(outCommit, txHash, truncatedMemo)

      pool.optimisticState.updateState(commitIndex, outCommit, prefixedMemo)
      jobLogger.debug('Adding nullifier %s to OS', nullifier)
      await pool.optimisticState.nullifiers.add([nullifier])

      const sentJob = await sentTxQueue.add(
        txHash,
        {
          poolJobId: job.id as string,
          root: rootAfter,
          outCommit,
          commitIndex,
          truncatedMemo,
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
      jobLogger.info(`Added sentTxWorker job: ${sentJob.id}`)

      txHashes.push([txHash, sentJob.id as string])
    }

    return txHashes
  }

  const poolTxWorker = new Worker<BatchTx, PoolTxResult[]>(
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
