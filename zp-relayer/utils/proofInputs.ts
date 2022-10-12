import BN from 'bn.js'
import { toBN } from 'web3-utils'
import { Helpers, Proof } from 'libzkbob-rs-node'

export interface Delta {
  transferIndex: BN
  energyAmount: BN
  tokenAmount: BN
  poolId: BN
}

export function parseDelta(delta: string): Delta {
  const { poolId, index, e, v } = Helpers.parseDelta(delta)
  return {
    transferIndex: toBN(index),
    energyAmount: toBN(e),
    tokenAmount: toBN(v),
    poolId: toBN(poolId),
  }
}

type TxProofField = 'root' | 'nullifier' | 'out_commit' | 'delta' | 'memo'
type TxProofFieldMapping = {
  [key in TxProofField]: number
}
const txProofFieldMapping: TxProofFieldMapping = {
  root: 0,
  nullifier: 1,
  out_commit: 2,
  delta: 3,
  memo: 4,
}
export function getTxProofField<T extends TxProofField>({ inputs }: Proof, field: T): string {
  if (inputs.length !== 5) throw new Error('Incorrect number of proof inputs')
  return inputs[txProofFieldMapping[field]]
}
