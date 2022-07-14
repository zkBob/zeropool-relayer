import { toBN, toWei } from 'web3-utils'
import { Worker } from 'bullmq'
import { web3 } from './services/web3'
import { logger } from './services/appLogger'
import { TxPayload } from './services/poolTxQueue'
import { TX_QUEUE_NAME, OUTPLUSONE, MAX_SENT_LIMIT, TX_CHECK_DELAY } from './utils/constants'
import { readNonce, updateField, RelayerKeys, incrNonce } from './utils/redisFields'
import { numToHex, truncateMemoTxPrefix } from './utils/helpers'
import { signAndSend } from './tx/signAndSend'
import { pool } from './pool'
import { sentTxQueue } from './services/sentTxQueue'
import { processTx } from './txProcessor'
import { config } from './config/config'
import { redis } from './services/redisClient'
import { checkAssertion, checkTransferIndex, parseDelta } from './validation'
import type { EstimationType, GasPrice } from './services/GasPrice'

const { RELAYER_ADDRESS_PRIVATE_KEY } = process.env as Record<PropertyKey, string>

const WORKER_OPTIONS = {
  autorun: false,
  connection: redis,
  concurrency: 1,
}

export async function createPoolTxWorker<T extends EstimationType>(gasPrice: GasPrice<T>) {
  await updateField(RelayerKeys.NONCE, await readNonce(true))
  const poolTxWorker = new Worker<TxPayload[]>(
    TX_QUEUE_NAME,
    async job => {
      const txs = job.data

      const logPrefix = `POOL WORKER: Job ${job.id}:`
      logger.info('%s processing...', logPrefix)
      logger.info('Recieved %s txs', txs.length)

      const txHashes = []
      for (const tx of txs) {
        const { gas, amount, rawMemo, txType, txProof } = tx

        const delta = parseDelta(txProof.inputs[3])
        await checkAssertion(
          () => checkTransferIndex(toBN(pool.optimisticState.getNextIndex()), delta.transferIndex),
          `Incorrect transfer index`
        )

        const { data, commitIndex } = await processTx(job.id as string, tx, pool)
        const outCommit = txProof.inputs[2]

        const nonce = await incrNonce()
        logger.info(`${logPrefix} nonce: ${nonce}`)

        let txHash: string
        const gasPriceOptions = gasPrice.getPrice()
        const txConfig = {
          data,
          nonce,
          value: toWei(toBN(amount)),
          gas,
          to: config.poolAddress,
          chainId: pool.chainId,
          ...gasPriceOptions,
        }
        try {
          const txHash = await signAndSend(txConfig, RELAYER_ADDRESS_PRIVATE_KEY, web3)
          logger.debug(`${logPrefix} TX hash ${txHash}`)

          await updateField(RelayerKeys.TRANSFER_NUM, commitIndex * OUTPLUSONE)

          const truncatedMemo = truncateMemoTxPrefix(rawMemo, txType)
          const txData = numToHex(toBN(outCommit)).concat(txHash.slice(2)).concat(truncatedMemo)

          pool.optimisticState.updateState(commitIndex, outCommit, txData)

          txHashes.push(txHash)

          await sentTxQueue.add(
            txHash,
            {
              payload: tx,
              outCommit,
              commitIndex,
              txHash,
              txData,
              txConfig: {},
            },
            {
              delay: TX_CHECK_DELAY,
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
    },
    WORKER_OPTIONS
  )

  poolTxWorker.on('error', e => {
    logger.info('POOL_WORKER ERR: %o', e)
  })

  return poolTxWorker
}
