import { toBN, toWei } from 'web3-utils'
import { Job, Worker } from 'bullmq'
import { web3 } from '../services/web3'
import { logger } from '../services/appLogger'
import { TxPayload } from '../queue/poolTxQueue'
import { TX_QUEUE_NAME, OUTPLUSONE, MAX_SENT_LIMIT } from '../utils/constants'
import { readNonce, updateField, RelayerKeys, incrNonce } from '../utils/redisFields'
import { numToHex, truncateMemoTxPrefix, withMutex } from '../utils/helpers'
import { signAndSend } from '../tx/signAndSend'
import { pool } from '../pool'
import { sentTxQueue } from '../queue/sentTxQueue'
import { processTx } from '../txProcessor'
import config from '../config'
import { redis } from '../services/redisClient'
import { checkAssertion, checkNullifier, checkTransferIndex, parseDelta } from '../validateTx'
import type { EstimationType, GasPrice } from '../services/GasPrice'
import type { Mutex } from 'async-mutex'
import { getChainId } from '../utils/web3'

const WORKER_OPTIONS = {
  autorun: false,
  connection: redis,
  concurrency: 1,
}

export async function createPoolTxWorker<T extends EstimationType>(gasPrice: GasPrice<T>, mutex: Mutex) {
  const CHAIN_ID = await getChainId(web3)
  const poolTxWorkerProcessor = async (job: Job<TxPayload[]>) => {
    const txs = job.data

    const logPrefix = `POOL WORKER: Job ${job.id}:`
    logger.info('%s processing...', logPrefix)
    logger.info('Recieved %s txs', txs.length)

    const txHashes = []
    for (const tx of txs) {
      const { gas, amount, rawMemo, txType, txProof } = tx

      const nullifier = txProof.inputs[1]
      const outCommit = txProof.inputs[2]
      const delta = parseDelta(txProof.inputs[3])

      await checkAssertion(
        () => checkNullifier(nullifier, pool.state.nullifiers),
        `Doublespend detected in confirmed state`
      )
      await checkAssertion(
        () => checkNullifier(nullifier, pool.optimisticState.nullifiers),
        `Doublespend detected in optimistic state`
      )
      await checkAssertion(
        () => checkTransferIndex(toBN(pool.optimisticState.getNextIndex()), delta.transferIndex),
        `Incorrect transfer index`
      )

      const { data, commitIndex } = await processTx(job.id as string, tx, pool)

      const nonce = await incrNonce()
      logger.info(`${logPrefix} nonce: ${nonce}`)

      const gasPriceOptions = gasPrice.getPrice()
      const txConfig = {
        data,
        nonce,
        value: toWei(toBN(amount)),
        gas,
        to: config.poolAddress,
        chainId: CHAIN_ID,
        ...gasPriceOptions,
      }
      try {
        const txHash = await signAndSend(txConfig, config.relayerPrivateKey, web3)
        logger.debug(`${logPrefix} TX hash ${txHash}`)

        await updateField(RelayerKeys.TRANSFER_NUM, commitIndex * OUTPLUSONE)

        const truncatedMemo = truncateMemoTxPrefix(rawMemo, txType)
        const txData = numToHex(toBN(outCommit)).concat(txHash.slice(2)).concat(truncatedMemo)

        pool.optimisticState.updateState(commitIndex, outCommit, txData)
        logger.info('Adding nullifier %s to OS', nullifier)
        await pool.optimisticState.nullifiers.add([nullifier])

        txHashes.push(txHash)

        await sentTxQueue.add(
          txHash,
          {
            payload: tx,
            outCommit,
            commitIndex,
            txHash,
            txData,
            nullifier,
            txConfig: {},
          },
          {
            delay: config.sentTxDelay,
            priority: txConfig.nonce,
          }
        )

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

  await updateField(RelayerKeys.NONCE, await readNonce(true))
  const poolTxWorker = new Worker<TxPayload[]>(
    TX_QUEUE_NAME,
    job => withMutex(mutex, () => poolTxWorkerProcessor(job)),
    WORKER_OPTIONS
  )

  poolTxWorker.on('error', e => {
    logger.info('POOL_WORKER ERR: %o', e)
  })

  return poolTxWorker
}
