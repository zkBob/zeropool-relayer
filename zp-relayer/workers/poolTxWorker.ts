import { toBN, toWei } from 'web3-utils'
import { Job, Worker } from 'bullmq'
import { web3, web3Redundant } from '@/services/web3'
import { logger } from '@/services/appLogger'
import type { BatchTx, PoolTxResult, TxPayload } from '@/queue/poolTxQueue'
import { TX_QUEUE_NAME, OUTPLUSONE } from '@/utils/constants'
import { readNonce, updateField, RelayerKeys, updateNonce } from '@/utils/redisFields'
import { buildPrefixedMemo, truncateMemoTxPrefix, withErrorLog, withMutex } from '@/utils/helpers'
import { signTransaction, sendTransaction } from '@/tx/signAndSend'
import { Pool, pool } from '@/pool'
import { sentTxQueue } from '@/queue/sentTxQueue'
import { processTx } from '@/txProcessor'
import config from '@/config'
import { addExtraGasPrice, EstimationType, GasPrice } from '@/services/gas-price'
import type { Mutex } from 'async-mutex'
import { getChainId } from '@/utils/web3'
import { getTxProofField } from '@/utils/proofInputs'
import type { Redis } from 'ioredis'
import { TxValidationError } from '@/validateTx'

export async function createPoolTxWorker<T extends EstimationType>(
  gasPrice: GasPrice<T>,
  validateTx: (tx: TxPayload, pool: Pool) => Promise<void>,
  mutex: Mutex,
  redis: Redis
) {
  const workerLogger = logger.child({ worker: 'pool' })
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  let nonce = await readNonce(true)
  await updateNonce(nonce)

  const CHAIN_ID = await getChainId(web3)
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

      await validateTx(tx, pool)

      const { data, commitIndex, rootAfter } = await processTx(tx)

      jobLogger.info(`nonce: ${nonce}`)

      const txConfig = {
        data,
        nonce,
        value: toWei(toBN(amount)),
        gas,
        to: config.poolAddress,
        chainId: CHAIN_ID,
      }
      try {
        const gasPriceValue = await gasPrice.fetchOnce()
        const gasPriceWithExtra = addExtraGasPrice(gasPriceValue, config.gasPriceSurplus)
        const [txHash, rawTransaction] = await signTransaction(
          web3,
          {
            ...txConfig,
            ...gasPriceWithExtra,
          },
          config.relayerPrivateKey
        )
        await sendTransaction(web3Redundant, rawTransaction)

        await updateNonce(++nonce)

        jobLogger.info('Sent tx', { txHash })

        await updateField(RelayerKeys.TRANSFER_NUM, commitIndex * OUTPLUSONE)

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
            prevAttempts: [[txHash, gasPriceWithExtra]],
            traceId,
          },
          {
            delay: config.sentTxDelay,
            priority: nonce,
          }
        )
        jobLogger.info(`Added sentTxWorker job: ${sentJob.id}`)

        txHashes.push([txHash, sentJob.id as string])
      } catch (e) {
        jobLogger.error(`Send TX failed: ${e}`)
        throw e
      }
    }

    return txHashes
  }

  const poolTxWorker = new Worker<BatchTx, PoolTxResult[]>(
    TX_QUEUE_NAME,
    job => withErrorLog(
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
