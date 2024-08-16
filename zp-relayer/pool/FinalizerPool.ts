import { logger } from '@/lib/appLogger'
import { Circuit, IProver } from '@/prover'
import { DirectDeposit, PoolTx, poolTxQueue, WorkerTxType } from '@/queue/poolTxQueue'
import { buildPrefixedMemo, flattenProof } from '@/utils/helpers'
import { DelegatedDepositsData } from 'libzkbob-rs-node'
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
  directDepositProver!: IProver<Circuit.DirectDeposit>
  indexerUrl!: string

  async init(
    treeProver: IProver<Circuit.Tree>,
    directDepositProver: IProver<Circuit.DirectDeposit>,
    indexerUrl: string
  ) {
    if (this.isInitialized) return

    this.treeProver = treeProver
    this.directDepositProver = directDepositProver
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

  async buildDirectDepositTx({
    transaction: { outCommit, deposits, txProof, memo },
  }: PoolTx<WorkerTxType.DirectDeposit>): Promise<ProcessResult<FinalizerPool>> {
    logger.info('Received direct deposit', { number: deposits.length })

    const func = 'appendDirectDeposits(uint256[],uint256,uint256[8],address)'

    const { treeProof, commitIndex } = await this.getTreeProof(outCommit)
    const rootAfter = treeProof.inputs[1]
    const indices = deposits.map(d => d.nonce)

    const data =
      AbiCoder.encodeFunctionSignature(func) +
      AbiCoder.encodeParameters(
        ['uint256[]', 'uint256', 'uint256[8]', 'address'],
        [indices, outCommit, flattenProof(txProof.proof), '0x0000000000000000000000000000000000000000']
      ).slice(2)

    return { data, func, commitIndex, outCommit, memo, root: rootAfter, mpc: false }
  }

  async getTreeProof(outCommit: string) {
    const { pub, sec, commitIndex } = this.state.getVirtualTreeProofInputs(outCommit)

    logger.debug('Proving tree...')
    const treeProof = await this.treeProver.prove(pub, sec)
    logger.debug('Tree proved')
    return { treeProof, commitIndex }
  }

  async getDirectDepositProof(deposits: DirectDeposit[]) {
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
    const proof = await this.directDepositProver.prove(pub, sec)
    return { proof, memo, outCommit }
  }

  async fetchCommitment() {
    try {
      const res = await this.network.pool.call('pendingCommitment')
      return res as PendingCommitment
    } catch (e) {
      //this corresponds to ZkBobPool: queue is empty which is not considered as error
       if ((e as any).data?.endsWith("195a6b426f62506f6f6c3a20717565756520697320656d70747900000000000000")) {
        return
       }
       logger.error(e)
      return 
    }
  }

  async onSend(p: ProcessResult<this>, txHash: string): Promise<void> {}

  async onConfirmed(
    { outCommit, memo, commitIndex, nullifier, root }: ProcessResult<this>,
    txHash: string,
    callback?: (() => Promise<void>) | undefined, 
    jobId?: string
  ): Promise<void> {
    const prefixedMemo = buildPrefixedMemo(outCommit, txHash, memo)
    this.optimisticState.updateState(commitIndex, outCommit, prefixedMemo)
    
    if (!jobId) {
      logger.error('Pool job not found', { jobId });
      return;
    }

    const poolJob = await poolTxQueue.getJob(jobId);
    if (poolJob?.data.type === WorkerTxType.Finalize) {
      this.state.updateState(commitIndex, outCommit, prefixedMemo)

      const rootConfirmed = this.state.getMerkleRoot()
      logger.info('Assert roots are equal')
      if (rootConfirmed !== root) {
        // TODO: Should be impossible but in such case
        // we should recover from some checkpoint
        logger.error('Roots are not equal: %s should be %s', rootConfirmed, root)
      }
    }

    if (callback) {
      await callback()
    }
  }
}
