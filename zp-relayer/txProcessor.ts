import Contract from 'web3-eth-contract'
import { AbiItem, toBN } from 'web3-utils'
import type { TxType } from 'zp-memo-parser'
import { SnarkProof, Proof } from 'libzkbob-rs-node'
import PoolAbi from './abi/pool-abi.json'
import { logger } from './services/appLogger'
import { TRANSFER_INDEX_SIZE, ENERGY_SIZE, TOKEN_SIZE } from './utils/constants'
import { numToHex, flattenProof, truncateHexPrefix, encodeProof, truncateMemoTxPrefix } from './utils/helpers'
import { Delta, getTxProofField, parseDelta } from './utils/proofInputs'
import { pool } from './pool'
import type { WorkerTx, WorkerTxType } from './queue/poolTxQueue'

// @ts-ignore
// Used only to get `transact` method selector
const PoolInstance = new Contract(PoolAbi as AbiItem[])

interface TxData {
  txProof: SnarkProof
  treeProof: SnarkProof
  nullifier: string
  outCommit: string
  rootAfter: string
  delta: Delta
  txType: TxType
  memo: string
  depositSignature: string | null
}

function buildTxData(txData: TxData) {
  const selector: string = PoolInstance.methods.transact().encodeABI()

  const transferIndex = numToHex(txData.delta.transferIndex, TRANSFER_INDEX_SIZE)
  const energyAmount = numToHex(txData.delta.energyAmount, ENERGY_SIZE)
  const tokenAmount = numToHex(txData.delta.tokenAmount, TOKEN_SIZE)
  logger.debug(`DELTA ${transferIndex} ${energyAmount} ${tokenAmount}`)

  const txFlatProof = encodeProof(txData.txProof)
  const treeFlatProof = encodeProof(txData.treeProof)

  const memoMessage = txData.memo
  const memoSize = numToHex(toBN(memoMessage.length).divn(2), 4)

  const data = [
    selector,
    txData.nullifier,
    txData.outCommit,
    transferIndex,
    energyAmount,
    tokenAmount,
    txFlatProof,
    txData.rootAfter,
    treeFlatProof,
    txData.txType,
    memoSize,
    memoMessage,
  ]

  if (txData.depositSignature) {
    const signature = truncateHexPrefix(txData.depositSignature)
    data.push(signature)
  }

  return data.join('')
}

async function getTreeProof(outCommit: string) {
  const { pub, sec, commitIndex } = pool.optimisticState.getVirtualTreeProofInputs(outCommit)

  logger.debug(`Proving tree...`)
  const treeProof = await Proof.treeAsync(pool.treeParams, pub, sec)
  logger.debug(`Tree proved`)
  return { treeProof, commitIndex }
}

export interface ProcessResult {
  data: string
  commitIndex: number
  outCommit: string
  rootAfter: string
  memo: string
  nullifier?: string
}

export async function buildTx(tx: WorkerTx<WorkerTxType.Normal>): Promise<ProcessResult> {
  const { txType, txProof, rawMemo, depositSignature } = tx

  const nullifier = getTxProofField(txProof, 'nullifier')
  const outCommit = getTxProofField(txProof, 'out_commit')
  const delta = parseDelta(getTxProofField(txProof, 'delta'))

  const { treeProof, commitIndex } = await getTreeProof(outCommit)

  const rootAfter = treeProof.inputs[1]
  const data = buildTxData({
    txProof: txProof.proof,
    treeProof: treeProof.proof,
    nullifier: numToHex(toBN(nullifier)),
    outCommit: numToHex(toBN(outCommit)),
    rootAfter: numToHex(toBN(rootAfter)),
    delta,
    txType,
    memo: rawMemo,
    depositSignature,
  })

  const memo = truncateMemoTxPrefix(rawMemo, txType)

  return { data, commitIndex, outCommit, rootAfter, nullifier, memo }
}

export async function buildDirectDeposits(tx: WorkerTx<WorkerTxType.DirectDeposit>): Promise<ProcessResult> {
  if (tx.txProof) {
    // If we already have a proof just verify it
    // TODO: get proof + outCommit for all deposits directDeposits
    // Now, just use some random value
  } else {
    // Build new proof
  }
  const outCommit = '11469701942666298368112882412133877458305516134926649826543144744382391691533'

  const { treeProof, commitIndex } = await getTreeProof(outCommit)

  const rootAfter = treeProof.inputs[1]
  const indices = tx.deposits.map(d => d.nonce)

  const data: string = PoolInstance.methods
    .appendDirectDeposits(
      rootAfter,
      indices,
      outCommit,
      // TODO: use DD proof here
      flattenProof(treeProof.proof),
      flattenProof(treeProof.proof)
    )
    .encodeABI()

  // TODO: add memo constructor after contract upgrade
  const memo = ''

  return { data, commitIndex, outCommit, rootAfter, memo }
}
