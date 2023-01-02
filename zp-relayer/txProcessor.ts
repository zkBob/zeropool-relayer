import Contract from 'web3-eth-contract'
import PoolAbi from './abi/pool-abi.json'
import { AbiItem, toBN } from 'web3-utils'
import { logger } from './services/appLogger'
import { TRANSFER_INDEX_SIZE, ENERGY_SIZE, TOKEN_SIZE } from './utils/constants'
import { numToHex, flattenProof, truncateHexPrefix } from './utils/helpers'
import { Delta, getTxProofField, parseDelta } from './utils/proofInputs'
import { SnarkProof, Proof } from 'libzkbob-rs-node'
import { TxType } from 'zp-memo-parser'
import { pool } from './pool'
import { TxPayload } from './queue/poolTxQueue'

// @ts-ignore
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

  const txFlatProof = flattenProof(txData.txProof)
  const treeFlatProof = flattenProof(txData.treeProof)

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

export async function processTx(tx: TxPayload) {
  const { txType, txProof, rawMemo: memo, depositSignature } = tx

  const nullifier = getTxProofField(txProof, 'nullifier')
  const outCommit = getTxProofField(txProof, 'out_commit')
  const delta = parseDelta(getTxProofField(txProof, 'delta'))

  const { pub, sec, commitIndex } = pool.optimisticState.getVirtualTreeProofInputs(outCommit)

  logger.debug(`Proving tree...`)
  const treeProof = await Proof.treeAsync(pool.treeParams, pub, sec)
  logger.debug(`Tree proved`)

  const rootAfter = treeProof.inputs[1]
  const data = buildTxData({
    txProof: txProof.proof,
    treeProof: treeProof.proof,
    nullifier: numToHex(toBN(nullifier)),
    outCommit: numToHex(toBN(outCommit)),
    rootAfter: numToHex(toBN(rootAfter)),
    delta,
    txType,
    memo,
    depositSignature,
  })
  return { data, commitIndex, rootAfter }
}
