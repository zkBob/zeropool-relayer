import Contract from 'web3-eth-contract'
import { AbiItem, toBN } from 'web3-utils'
import type { TxType } from 'zp-memo-parser'
import { DelegatedDepositsData, SnarkProof } from 'libzkbob-rs-node'
import type { PoolState } from './state/PoolState'
import PoolAbi from './abi/pool-abi.json'
import { logger } from './services/appLogger'
import { TRANSFER_INDEX_SIZE, ENERGY_SIZE, TOKEN_SIZE } from './utils/constants'
import { numToHex, flattenProof, truncateHexPrefix, encodeProof, truncateMemoTxPrefix } from './utils/helpers'
import { Delta, getTxProofField, parseDelta } from './utils/proofInputs'
import type { DirectDeposit, WorkerTx, WorkerTxType } from './queue/poolTxQueue'
import type { Circuit, IProver } from './prover/IProver'

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

  txData.txProof.a = ['0', '0']
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

async function getTreeProof(state: PoolState, outCommit: string, prover: IProver<Circuit.Tree>) {
  const { pub, sec, commitIndex } = state.getVirtualTreeProofInputs(outCommit)

  logger.debug(`Proving tree...`)
  const treeProof = await prover.prove(pub, sec)
  logger.debug(`Tree proved`)
  return { treeProof, commitIndex }
}

export async function getDirectDepositProof(deposits: DirectDeposit[], prover: IProver<Circuit.DirectDeposit>) {
  const {
    public: pub,
    secret: sec,
    memo,
    out_commitment_hash: outCommit,
  } = await DelegatedDepositsData.create(
    deposits.map(d => {
      return {
        id: d.nonce,
        receiver_d: toBN(d.zkAddress.diversifier).toString(10),
        receiver_p: toBN(d.zkAddress.pk).toString(10),
        denominated_amount: d.deposit,
      }
    })
  )
  const proof = await prover.prove(pub, sec)
  return { proof, memo, outCommit }
}

export interface ProcessResult {
  data: string
  func: string
  commitIndex: number
  outCommit: string
  rootAfter: string
  memo: string
  nullifier?: string
}

export async function buildTx(
  tx: WorkerTx<WorkerTxType.Normal>,
  treeProver: IProver<Circuit.Tree>,
  state: PoolState
): Promise<ProcessResult> {
  const func = 'transact()'
  const { txType, txProof, rawMemo, depositSignature } = tx

  const nullifier = getTxProofField(txProof, 'nullifier')
  const outCommit = getTxProofField(txProof, 'out_commit')
  const delta = parseDelta(getTxProofField(txProof, 'delta'))

  const { treeProof, commitIndex } = await getTreeProof(state, outCommit, treeProver)

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

  return { data, func, commitIndex, outCommit, rootAfter, nullifier, memo }
}

export async function buildDirectDeposits(
  tx: WorkerTx<WorkerTxType.DirectDeposit>,
  treeProver: IProver<Circuit.Tree>,
  state: PoolState
): Promise<ProcessResult> {
  const func = 'appendDirectDeposits(uint256,uint256[],uint256,uint256[8],uint256[8])'
  const outCommit = tx.outCommit

  const { treeProof, commitIndex } = await getTreeProof(state, outCommit, treeProver)

  const rootAfter = treeProof.inputs[1]
  const indices = tx.deposits.map(d => d.nonce)

  const data: string = PoolInstance.methods
    .appendDirectDeposits(rootAfter, indices, outCommit, flattenProof(tx.txProof.proof), flattenProof(treeProof.proof))
    .encodeABI()

  return { data, func, commitIndex, outCommit, rootAfter, memo: tx.memo }
}
