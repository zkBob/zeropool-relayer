import { logger } from '@/lib/appLogger'
import { Circuit, IProver } from '@/prover'
import { PoolTx, WorkerTxType } from '@/queue/poolTxQueue'
import { buildPrefixedMemo, flattenProof } from '@/utils/helpers'
import AbiCoder from 'web3-eth-abi'
import { toBN } from 'web3-utils'
import { BasePool } from './BasePool'
import { ProcessResult } from './types'

export interface PendingCommitment {
  commitment: string
  privilegedProver: string
  fee: string
  timestamp: string
  gracePeriodEnd: string
}

export class FinalizerPool extends BasePool {
  treeProver!: IProver<Circuit.Tree>
  indexerUrl!: string

  async init(treeProver: IProver<Circuit.Tree>, indexerUrl: string) {
    if (this.isInitialized) return

    this.treeProver = treeProver
    this.indexerUrl = indexerUrl

    this.denominator = toBN(await this.network.pool.call('denominator'))
    this.poolId = toBN(await this.network.pool.call('pool_id'))

    await this.syncState(undefined, undefined, indexerUrl)

    this.isInitialized = true
  }

  async validateTx(): Promise<void> {}

  async buildFinalizeTx({
    transaction: { outCommit },
  }: PoolTx<WorkerTxType.Finalize>): Promise<ProcessResult<FinalizerPool>> {
    await this.syncState(undefined, undefined, this.indexerUrl)

    const func = 'proveTreeUpdate(uint256,uint256[8],uint256)'

    const { treeProof, commitIndex } = await this.getTreeProof(outCommit)
    const rootAfter = treeProof.inputs[1]

    const treeFlatProof = flattenProof(treeProof.proof)

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
    const { pub, sec, commitIndex } = this.state.getVirtualTreeProofInputs(outCommit)

    logger.debug('Proving tree...')
    const treeProof = await this.treeProver.prove(pub, sec)
    logger.debug('Tree proved')
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

  async onSend(p: ProcessResult<this>, txHash: string): Promise<void> {}

  async onConfirmed(
    { outCommit, memo, commitIndex, nullifier, root }: ProcessResult<this>,
    txHash: string,
    callback?: (() => Promise<void>) | undefined
  ): Promise<void> {
    const prefixedMemo = buildPrefixedMemo(outCommit, txHash, memo)
    this.state.updateState(commitIndex, outCommit, prefixedMemo)
    this.optimisticState.updateState(commitIndex, outCommit, prefixedMemo)

    // Add nullifier to confirmed state and remove from optimistic one
    if (nullifier) {
      logger.info('Adding nullifier %s to PS', nullifier)
      await this.state.nullifiers.add([nullifier])
    }

    const rootConfirmed = this.state.getMerkleRoot()
    logger.info('Assert roots are equal')
    if (rootConfirmed !== root) {
      // TODO: Should be impossible but in such case
      // we should recover from some checkpoint
      logger.error('Roots are not equal: %s should be %s', rootConfirmed, root)
    }

    if (callback) {
      await callback()
    }
  }
}
