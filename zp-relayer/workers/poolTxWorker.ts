import { toBN, toWei } from 'web3-utils'
import { Job, Worker } from 'bullmq'
import { web3 } from '@/services/web3'
import { logger } from '@/services/appLogger'
import { PoolTxResult, TxPayload } from '@/queue/poolTxQueue'
import { TX_QUEUE_NAME, OUTPLUSONE, MAX_SENT_LIMIT } from '@/utils/constants'
import { readNonce, updateField, RelayerKeys, incrNonce, updateNonce } from '@/utils/redisFields'
import { numToHex, truncateMemoTxPrefix, withErrorLog, withMutex } from '@/utils/helpers'
import { signAndSend } from '@/tx/signAndSend'
import { pool } from '@/pool'
import { sentTxQueue } from '@/queue/sentTxQueue'
import { processTx } from '@/txProcessor'
import config from '@/config'
import { validateTx } from '@/validateTx'
import { addExtraGasPrice, EstimationType, GasPrice } from '@/services/gas-price'
import type { Mutex } from 'async-mutex'
import { getChainId } from '@/utils/web3'
import { getTxProofField } from '@/utils/proofInputs'
import type Redis from 'ioredis'


export async function createPoolTxWorker<T extends EstimationType>(gasPrice: GasPrice<T>, mutex: Mutex, redis: Redis) {
  const WORKER_OPTIONS = {
    autorun: false,
    connection: redis,
    concurrency: 1,
  }

  const CHAIN_ID = await getChainId(web3)
  const poolTxWorkerProcessor = async (job: Job<TxPayload[]>) => {
    const txs = job.data

    const logPrefix = `POOL WORKER: Job ${job.id}:`
    logger.info('%s processing...', logPrefix)
    logger.info('Recieved %s txs', txs.length)

    const txHashes: [string, string][] = []
    for (const tx of txs) {
      const { gas, amount, rawMemo, txType, txProof } = tx

      const txData = await validateTx(tx, pool)

      const { data, commitIndex, rootAfter } = await processTx(job.id as string, tx)

      const nonce = await incrNonce()
      logger.info(`${logPrefix} nonce: ${nonce}`)

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
        const gasPriceWithExtra = addExtraGasPrice(gasPriceValue, config.gasPriceInitialSurplus)
        const txHash = await signAndSend(
          {
            ...txConfig,
            ...gasPriceWithExtra,
          },
          config.relayerPrivateKey,
          web3
        )
        logger.debug(`${logPrefix} TX hash ${txHash}`)

        await updateField(RelayerKeys.TRANSFER_NUM, commitIndex * OUTPLUSONE)

        const nullifier = getTxProofField(txProof, 'nullifier')
        const outCommit = getTxProofField(txProof, 'out_commit')

        const truncatedMemo = truncateMemoTxPrefix(rawMemo, txType)
        const prefixedMemo = numToHex(toBN(outCommit)).concat(txHash.slice(2)).concat(truncatedMemo)

        pool.optimisticState.updateState(commitIndex, outCommit, prefixedMemo)
        logger.debug('Adding nullifier %s to OS', nullifier)
        await pool.optimisticState.nullifiers.add([nullifier])
        const poolIndex = (commitIndex + 1) * OUTPLUSONE
        logger.debug('Adding root %s at %s to OS', rootAfter, poolIndex)
        await pool.optimisticState.roots.add({
          [poolIndex]: rootAfter,
        })

        const sentJob = await sentTxQueue.add(
          txHash,
          {
            txType,
            root: rootAfter,
            outCommit,
            commitIndex,
            txHash,
            prefixedMemo,
            nullifier,
            txConfig,
            gasPriceOptions: gasPriceWithExtra,
            txData,
          },
          {
            delay: config.sentTxDelay,
            priority: txConfig.nonce,
          }
        )

        txHashes.push([txHash, sentJob.id as string])

        const sentTxNum = await sentTxQueue.count()
        if (sentTxNum > MAX_SENT_LIMIT) {
          await poolTxWorker.pause()
        }
      } catch (e) {
        logger.error(`${logPrefix} Send TX failed: ${e}`)
        throw e
      }
    }

    return txHashes
  }

  await updateNonce(await readNonce(true))
  const poolTxWorker = new Worker<TxPayload[], PoolTxResult[]>(
    TX_QUEUE_NAME,
    job => withErrorLog(withMutex(mutex, () => poolTxWorkerProcessor(job))),
    WORKER_OPTIONS
  )

  poolTxWorker.on('error', e => {
    logger.info('POOL_WORKER ERR: %o', e)
  })

  return poolTxWorker
}
