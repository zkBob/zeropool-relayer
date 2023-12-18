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

type Stringified<T> = {
  [P in keyof T]: string
}
export interface TxData {
  txProof: SnarkProof
  treeProof: SnarkProof
  nullifier: string
  outCommit: string
  rootAfter: string
  delta: Stringified<Omit<Delta, 'poolId'>>
  txType: TxType
  memo: string
  depositSignature: string | null
}

export function buildTxData(txData: TxData, mpcSignatures: string[] = []) {
  const selector: string = PoolInstance.methods.transact().encodeABI()

  const { transferIndex, energyAmount, tokenAmount } = txData.delta
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

  if (mpcSignatures.length > 0) {
    data.push(numToHex(toBN(mpcSignatures.length), 2))
    data.push(...mpcSignatures)
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
  mpc: boolean
}

export async function buildTx(
  tx: WorkerTx<WorkerTxType.Normal>,
  treeProver: IProver<Circuit.Tree>,
  state: PoolState,
  mpcGuards: [string, string][] | null
): Promise<ProcessResult> {
  const func = 'transact()'
  const { txType, txProof, rawMemo, depositSignature } = tx

  const nullifier = getTxProofField(txProof, 'nullifier')
  const outCommit = getTxProofField(txProof, 'out_commit')
  const delta = parseDelta(getTxProofField(txProof, 'delta'))

  const { treeProof, commitIndex } = await getTreeProof(state, outCommit, treeProver)

  const rootAfter = treeProof.inputs[1]

  const txData: TxData = {
    txProof: txProof.proof,
    treeProof: treeProof.proof,
    delta: {
      transferIndex: numToHex(delta.transferIndex, TRANSFER_INDEX_SIZE),
      energyAmount: numToHex(delta.energyAmount, ENERGY_SIZE),
      tokenAmount: numToHex(delta.tokenAmount, TOKEN_SIZE),
    },
    txType,
    memo: rawMemo,
    depositSignature,
    nullifier: numToHex(toBN(nullifier)),
    outCommit: numToHex(toBN(outCommit)),
    rootAfter: numToHex(toBN(rootAfter)),
  }

  let mpc = false
  const mpcSignatures = []
  if (mpcGuards) {
    for (const [, guardHttp] of mpcGuards) {
      const rawRes = await fetch(guardHttp, {
        headers: {
          'Content-type': 'application/json',
        },
        method: 'POST',
        body: JSON.stringify(txData),
      })
      const res = await rawRes.json()
      const signature = truncateHexPrefix(res.signature)
      mpcSignatures.push(signature)
    }
    mpc = true
  }

  const data = buildTxData(txData, mpcSignatures)

  const memo = truncateMemoTxPrefix(rawMemo, txType)

  return { data, func, commitIndex, outCommit, rootAfter, nullifier, memo, mpc }
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

  return { data, func, commitIndex, outCommit, rootAfter, memo: tx.memo, mpc: false }
}
