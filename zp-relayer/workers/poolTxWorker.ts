import { toBN, toWei } from 'web3-utils'
import { Job, Worker } from 'bullmq'
import { web3, web3Redundant } from '@/services/web3'
import { logger } from '@/services/appLogger'
import { poolTxQueue, PoolTxResult, TxPayload } from '@/queue/poolTxQueue'
import { TX_QUEUE_NAME, OUTPLUSONE } from '@/utils/constants'
import { readNonce, updateField, RelayerKeys, updateNonce } from '@/utils/redisFields'
import { buildPrefixedMemo, truncateMemoTxPrefix, waitForFunds, withErrorLog, withMutex } from '@/utils/helpers'
import { signTransaction, sendTransaction } from '@/tx/signAndSend'
import { Pool, pool } from '@/pool'
import { sentTxQueue } from '@/queue/sentTxQueue'
import { processTx } from '@/txProcessor'
import config from '@/config'
import { addExtraGasPrice, EstimationType, GasPrice, getMaxRequiredGasPrice } from '@/services/gas-price'
import type { Mutex } from 'async-mutex'
import { getChainId } from '@/utils/web3'
import { getTxProofField } from '@/utils/proofInputs'
import type { Redis } from 'ioredis'
import { isInsufficientBalanceError } from '@/utils/web3Errors'
import { TxValidationError } from '@/validateTx'

export async function createPoolTxWorker<T extends EstimationType>(
  gasPrice: GasPrice<T>,
  validateTx: (tx: TxPayload, pool: Pool) => Promise<void>,
  mutex: Mutex,
  redis: Redis
) {
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  let nonce = await readNonce(true)
  await updateNonce(nonce)

  const CHAIN_ID = await getChainId(web3)
  const poolTxWorkerProcessor = async (job: Job<TxPayload[]>) => {
    const sentTxNum = await sentTxQueue.count()
    if (sentTxNum >= config.maxSentQueueSize) {
      throw new Error('Optimistic state overflow')
    }

    const txs = job.data

    const logPrefix = `POOL WORKER: Job ${job.id}:`
    logger.info('%s processing...', logPrefix)
    logger.info('Received %s txs', txs.length)

    const txHashes: [string, string][] = []
    for (const tx of txs) {
      const { gas, amount, rawMemo, txType, txProof } = tx

      await validateTx(tx, pool)

      const { data, commitIndex, rootAfter } = await processTx(job.id as string, tx)

      logger.info(`${logPrefix} nonce: ${nonce}`)

      const txConfig = {
        data,
        nonce,
        value: toWei(toBN(amount)),
        gas,
        to: config.poolAddress,
        chainId: CHAIN_ID,
      }
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
      try {
        await sendTransaction(web3Redundant, rawTransaction)
      } catch (e) {
        const err = e as Error
        if (isInsufficientBalanceError(err)) {
          const minimumBalance = toBN(gas).mul(toBN(getMaxRequiredGasPrice(gasPriceWithExtra)))
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
        throw e
      }

      await updateNonce(++nonce)

      logger.info(`${logPrefix} TX hash ${txHash}`)

      await updateField(RelayerKeys.TRANSFER_NUM, commitIndex * OUTPLUSONE)

      const nullifier = getTxProofField(txProof, 'nullifier')
      const outCommit = getTxProofField(txProof, 'out_commit')

      const truncatedMemo = truncateMemoTxPrefix(rawMemo, txType)
      const prefixedMemo = buildPrefixedMemo(outCommit, txHash, truncatedMemo)

      pool.optimisticState.updateState(commitIndex, outCommit, prefixedMemo)
      logger.debug('Adding nullifier %s to OS', nullifier)
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
        },
        {
          delay: config.sentTxDelay,
          priority: nonce,
        }
      )

      txHashes.push([txHash, sentJob.id as string])
    }

    return txHashes
  }

  const poolTxWorker = new Worker<TxPayload[], PoolTxResult[]>(
    TX_QUEUE_NAME,
    job => withErrorLog(
      withMutex(mutex, () => poolTxWorkerProcessor(job)),
      [TxValidationError]
    ),
    WORKER_OPTIONS
  )

  poolTxWorker.on('error', e => {
    logger.info('POOL_WORKER ERR: %o', e)
  })

  return poolTxWorker
}
