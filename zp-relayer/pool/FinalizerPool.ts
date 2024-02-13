import config from '@/configs/baseConfig'
import { logger } from '@/services/appLogger'
import { flattenProof } from '@/utils/helpers'
import AbiCoder from 'web3-eth-abi'
import { toBN } from 'web3-utils'
import { BasePool, ProcessResult } from './BasePool'

import { Circuit, IProver } from '@/prover'
import { PoolTx, WorkerTxType } from '@/queue/poolTxQueue'

export interface PendingCommitment {
  commitment: string
  privilegedProver: string
  fee: string
  timestamp: string
  gracePeriodEnd: string
}

export class FinalizerPool extends BasePool {
  treeProver!: IProver<Circuit.Tree>

  async init(sync: boolean = true, treeProver: IProver<Circuit.Tree>) {
    if (this.isInitialized) return

    this.treeProver = treeProver

    this.denominator = toBN(await this.network.pool.call('denominator'))
    this.poolId = toBN(await this.network.pool.call('pool_id'))

    if (sync) {
      await this.syncState(config.COMMON_START_BLOCK)
    }

    this.isInitialized = true
  }

  async validateTx(): Promise<void> {}

  async buildFinalizeTx({ transaction: { outCommit } }: PoolTx<WorkerTxType.Finalize>): Promise<ProcessResult> {
    const func = 'proveTreeUpdate(uint256,uint256[8],uint256)'
    const { treeProof, commitIndex } = await this.getTreeProof(outCommit)
    const rootAfter = treeProof.inputs[1]

    const treeFlatProof = flattenProof(treeProof.proof)

    console.log('Building')
    const data =
      AbiCoder.encodeFunctionSignature(func) +
      AbiCoder.encodeParameters(['uint256', 'uint256[8]', 'uint256'], [outCommit, treeFlatProof, rootAfter]).slice(2)

    return {
      data,
      func,
      commitIndex,
      outCommit,
      memo: '',
      root: rootAfter,
      mpc: false,
    }
  }

  async getTreeProof(outCommit: string) {
    const { pub, sec, commitIndex } = this.optimisticState.getVirtualTreeProofInputs(outCommit)

    logger.debug(`Proving tree...`)
    const treeProof = await this.treeProver.prove(pub, sec)
    logger.debug(`Tree proved`)
    return { treeProof, commitIndex }
  }

  async fetchCommitment() {
    try {
      const res = await this.network.pool.call('pendingCommitment')
      return res as PendingCommitment
    } catch (e) {
      return null
    }
  }
}
