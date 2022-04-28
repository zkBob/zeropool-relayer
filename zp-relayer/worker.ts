import PoolAbi from './abi/pool-abi.json'
import { AbiItem, toBN } from 'web3-utils'
import { Job, Worker } from 'bullmq'
import { web3 } from './services/web3'
import { logger } from './services/appLogger'
import { redis } from './services/redisClient'
import { TxPayload } from './services/jobQueue'
import { TX_QUEUE_NAME, OUTPLUSONE, TRANSFER_INDEX_SIZE, ENERGY_SIZE, TOKEN_SIZE } from './utils/constants'
import { readNonce, readTransferNum, updateField, RelayerKeys } from './utils/redisFields'
import { numToHex, flattenProof, truncateHexPrefix, truncateMemoTxPrefix } from './utils/helpers'
import { signAndSend } from './tx/signAndSend'
import { Helpers, SnarkProof } from 'libzeropool-rs-node'
import { pool } from './pool'
import { TxType } from 'zp-memo-parser'
import {
  Delta,
  parseDelta,
} from './validation'

const PoolInstance = new web3.eth.Contract(PoolAbi as AbiItem[])

const {
  RELAYER_ADDRESS_PRIVATE_KEY,
  GAS_PRICE,
} = process.env as Record<PropertyKey, string>

function buildTxData(
  txProof: SnarkProof,
  treeProof: SnarkProof,
  nullifier: string,
  outCommit: string,
  delta: Delta,
  rootAfter: string,
  txType: TxType,
  memo: string,
  depositSignature: string | null
) {

  const selector: string = PoolInstance.methods.transact().encodeABI()

  const transferIndex = numToHex(delta.transferIndex, TRANSFER_INDEX_SIZE)
  const energyAmount = numToHex(delta.energyAmount, ENERGY_SIZE)
  const tokenAmount = numToHex(delta.tokenAmount, TOKEN_SIZE)
  logger.debug(`DELTA ${transferIndex} ${energyAmount} ${tokenAmount}`)

  const txFlatProof = flattenProof(txProof)
  const treeFlatProof = flattenProof(treeProof)

  const memoMessage = memo
  const memoSize = numToHex(toBN(memoMessage.length).divn(2), 4)

  const data = [
    selector,
    nullifier,
    outCommit,
    transferIndex,
    energyAmount,
    tokenAmount,
    txFlatProof,
    rootAfter,
    treeFlatProof,
    txType,
    memoSize,
    memoMessage
  ]

  if (depositSignature) {
    depositSignature = truncateHexPrefix(depositSignature)
    data.push(depositSignature)
  }

  return data.join('')
}

async function processTx(job: Job<TxPayload>) {
  const {
    to,
    amount,
    gas,
    txProof,
    txType,
    rawMemo,
    depositSignature,
    created
  } = job.data
  const jobId = job.id

  const logPrefix = `Job ${jobId}:`

  await pool.syncState()

  logger.info(`${logPrefix} Recieved ${txType} tx with ${amount} native amount`)

  const contractTransferIndex = Number(await readTransferNum())
  const delta = parseDelta(txProof.inputs[3])

  const outCommit = txProof.inputs[2]
  const {
    proof: treeProof,
    nextCommitIndex
  } = pool.getVirtualTreeProof(outCommit, contractTransferIndex)

  const data = buildTxData(
    txProof.proof,
    treeProof.proof,
    numToHex(toBN(txProof.inputs[1])),
    numToHex(toBN(treeProof.inputs[2])),
    delta,
    numToHex(toBN(treeProof.inputs[1])),
    txType,
    rawMemo,
    depositSignature
  )

  const nonce = Number(await readNonce(true))
  const txHash = await signAndSend(
    RELAYER_ADDRESS_PRIVATE_KEY,
    data,
    nonce,
    GAS_PRICE,
    toBN(amount),
    gas,
    to,
    pool.chainId,
    web3
  )
  logger.debug(`${logPrefix} TX hash ${txHash}`)

  await updateField(RelayerKeys.NONCE, nonce + 1)
  await updateField(RelayerKeys.TRANSFER_NUM, contractTransferIndex + OUTPLUSONE)

  const truncatedMemo = truncateMemoTxPrefix(rawMemo, txType)
  const commitAndMemo = numToHex(toBN(outCommit)).concat(truncatedMemo)

  logger.debug(`${logPrefix} Updating tree`)
  pool.addCommitment(nextCommitIndex, Helpers.strToNum(outCommit))

  logger.debug(`${logPrefix} Adding tx to storage`)
  pool.txs.add(contractTransferIndex, Buffer.from(commitAndMemo, 'hex'))

  const elapsed = Date.now() -  (created??0)
  return {txHash, elapsed, created }
}


export async function createTxWorker() {
  // Reset nonce
  const nonce = Number(await readNonce(true))
  await updateField(RelayerKeys.NONCE, nonce + 1)

  await pool.init()

  const worker = new Worker<TxPayload>(
    TX_QUEUE_NAME,
    job => {
      logger.info(`Processing job ${job.id}...`)
      return processTx(job)
    },
    {
      connection: redis
    }
  )
  logger.info(`Worker ${worker.name}`)

  return worker
}
