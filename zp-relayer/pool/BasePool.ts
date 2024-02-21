import { BasePoolTx, JobState, PoolTx, poolTxQueue, WorkerTxType, WorkerTxTypePriority } from '@/queue/poolTxQueue'
import { logger } from '@/services/appLogger'
import { redis } from '@/services/redisClient'
import { PoolState } from '@/state/PoolState'
import { getBlockNumber } from '@/utils/web3'
import BN from 'bn.js'
import { Helpers, Proof, SnarkProof, VK } from 'libzkbob-rs-node'
import { toBN } from 'web3-utils'

import { FeeManager } from '@/services/fee'
import { NetworkBackend } from '@/services/network/NetworkBackend'
import { Network } from '@/services/network/types'
import { OUTPLUSONE } from '@/utils/constants'
import {
  buildPrefixedMemo,
  toTxType,
  truncateHexPrefix,
  truncateMemoTxPrefix,
  truncateMemoTxPrefixProverV2,
} from '@/utils/helpers'
import { PoolCalldataParser, PoolCalldataV2Parser } from '@/utils/PoolCalldataParser'
import AbiCoder from 'web3-eth-abi'
import { hexToNumber, hexToNumberString } from 'web3-utils'

export interface Limits {
  tvlCap: BN
  tvl: BN
  dailyDepositCap: BN
  dailyDepositCapUsage: BN
  dailyWithdrawalCap: BN
  dailyWithdrawalCapUsage: BN
  dailyUserDepositCap: BN
  dailyUserDepositCapUsage: BN
  depositCap: BN
  tier: BN
  dailyUserDirectDepositCap: BN
  dailyUserDirectDepositCapUsage: BN
  directDepositCap: BN
}

export interface LimitsFetch {
  deposit: {
    singleOperation: string
    dailyForAddress: {
      total: string
      available: string
    }
    dailyForAll: {
      total: string
      available: string
    }
    poolLimit: {
      total: string
      available: string
    }
  }
  withdraw: {
    dailyForAll: {
      total: string
      available: string
    }
  }
  dd: {
    singleOperation: string
    dailyForAddress: {
      total: string
      available: string
    }
  }
  tier: string
}

export interface OptionalChecks {
  treeProof?: {
    proof: Proof
    vk: VK
  }
  fee?: {
    feeManager: FeeManager
  }
  screener?: {
    screenerUrl: string
    screenerToken: string
  }
}

export interface ProcessResult {
  data: string
  func: string
  commitIndex: number
  outCommit: string
  memo: string
  nullifier?: string
  root: string
  mpc: boolean
}

export interface BasePoolConfig {
  statePath: string
  txVkPath: string
  eventsBatchSize: number
}

export abstract class BasePool<N extends Network = Network> {
  public txVK: VK
  public state: PoolState
  public optimisticState: PoolState
  public denominator: BN = toBN(1)
  public poolId: BN = toBN(0)
  public isInitialized = false

  constructor(public network: NetworkBackend<N>, private config: BasePoolConfig) {
    this.txVK = require(config.txVkPath)

    this.state = new PoolState('pool', redis, config.statePath)
    this.optimisticState = new PoolState('optimistic', redis, config.statePath)
  }

  loadState(states: { poolState: PoolState; optimisticState: PoolState }) {
    this.state = states.poolState
    this.optimisticState = states.optimisticState
  }

  abstract init(...args: any): Promise<void>

  async onSend({ outCommit, memo, commitIndex }: ProcessResult, txHash: string) {
    const prefixedMemo = buildPrefixedMemo(outCommit, txHash, memo)
    this.optimisticState.addTx(commitIndex * OUTPLUSONE, Buffer.from(prefixedMemo, 'hex'))
  }

  async onConfirmed(
    { outCommit, memo, commitIndex, nullifier, root }: ProcessResult,
    txHash: string,
    callback?: () => Promise<void>
  ): Promise<void> {
    const prefixedMemo = buildPrefixedMemo(outCommit, txHash, memo)
    this.state.updateState(commitIndex, outCommit, prefixedMemo)
    // Update tx hash in optimistic state tx db
    this.optimisticState.addTx(commitIndex * OUTPLUSONE, Buffer.from(prefixedMemo, 'hex'))

    // Add nullifier to confirmed state and remove from optimistic one
    if (nullifier) {
      logger.info('Adding nullifier %s to PS', nullifier)
      await this.state.nullifiers.add([nullifier])
      logger.info('Removing nullifier %s from OS', nullifier)
      await this.optimisticState.nullifiers.remove([nullifier])
    }

    const node1 = this.state.getCommitment(commitIndex)
    const node2 = this.optimisticState.getCommitment(commitIndex)
    logger.info('Assert commitments are equal: %s, %s', node1, node2)
    if (node1 !== node2) {
      logger.error('Commitments are not equal, state is corrupted')
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

  async onFailed(txHash: string): Promise<void> {
    logger.error('Transaction reverted', { txHash })

    await this.clearOptimisticState()
  }

  validateTx(tx: PoolTx<WorkerTxType>, optionalChecks: OptionalChecks, traceId?: string): Promise<void> {
    switch (tx.type) {
      case WorkerTxType.Normal:
        return this.validateNormalTx(tx as PoolTx<WorkerTxType.Normal>, optionalChecks, traceId)
      case WorkerTxType.DirectDeposit:
        return this.validateDirectDepositTx(tx as PoolTx<WorkerTxType.DirectDeposit>, optionalChecks, traceId)
      case WorkerTxType.Finalize:
        return this.validateFinalizeTx(tx as PoolTx<WorkerTxType.Finalize>, optionalChecks, traceId)
      default:
        throw new Error(`Unknown tx type: ${tx.type}`)
    }
  }
  validateDirectDepositTx(
    _tx: PoolTx<WorkerTxType.DirectDeposit>,
    _optionalChecks: OptionalChecks,
    _traceId: string | undefined
  ): Promise<void> {
    throw new Error('Method not implemented.')
  }
  validateFinalizeTx(
    _tx: PoolTx<WorkerTxType.Finalize>,
    _optionalChecks: OptionalChecks,
    _traceId: string | undefined
  ): Promise<void> {
    throw new Error('Method not implemented.')
  }
  validateNormalTx(
    _tx: PoolTx<WorkerTxType.Normal>,
    _optionalChecks: OptionalChecks,
    _traceId?: string
  ): Promise<void> {
    throw new Error('Method not implemented.')
  }

  buildTx(tx: PoolTx<WorkerTxType>): Promise<ProcessResult> {
    switch (tx.type) {
      case WorkerTxType.Normal:
        return this.buildNormalTx(tx as PoolTx<WorkerTxType.Normal>)
      case WorkerTxType.DirectDeposit:
        return this.buildDirectDepositTx(tx as PoolTx<WorkerTxType.DirectDeposit>)
      case WorkerTxType.Finalize:
        return this.buildFinalizeTx(tx as PoolTx<WorkerTxType.Finalize>)
      default:
        throw new Error(`Unknown tx type: ${tx.type}`)
    }
  }
  buildNormalTx(tx: PoolTx<WorkerTxType.Normal>): Promise<ProcessResult> {
    throw new Error('Method not implemented.')
  }
  buildDirectDepositTx(tx: PoolTx<WorkerTxType.DirectDeposit>): Promise<ProcessResult> {
    throw new Error('Method not implemented.')
  }
  buildFinalizeTx(tx: PoolTx<WorkerTxType.Finalize>): Promise<ProcessResult> {
    throw new Error('Method not implemented.')
  }

  async transact(tx: BasePoolTx, traceId?: string) {
    const queueTx = {
      ...tx,
      txHash: null,
      sentJobId: null,
      state: JobState.WAITING,
    }

    const job = await poolTxQueue.add(
      'tx',
      { type: WorkerTxType.Normal, transaction: queueTx, traceId },
      {
        priority: WorkerTxTypePriority[WorkerTxType.Normal],
      }
    )
    logger.debug(`Added poolTxWorker job: ${job.id}`)
    return job.id
  }

  async clearOptimisticState() {
    logger.info('Rollback optimistic state...')
    this.optimisticState.rollbackTo(this.state)
    logger.info('Clearing optimistic nullifiers...')
    await this.optimisticState.nullifiers.clear()

    const root1 = this.state.getMerkleRoot()
    const root2 = this.optimisticState.getMerkleRoot()
    logger.info(`Assert roots are equal: ${root1}, ${root2}, ${root1 === root2}`)
  }

  async getLastBlockToProcess() {
    const lastBlockNumber = await getBlockNumber(this.network)
    return lastBlockNumber
  }

  async syncState(startBlock: number) {
    logger.debug('Syncing state; starting from block %d', startBlock)

    const localIndex = this.state.getNextIndex()
    const localRoot = this.state.getMerkleRoot()

    const contractIndex = await this.getContractIndex()
    const contractRoot = await this.getContractMerkleRoot(contractIndex)

    logger.debug('State info', {
      localRoot,
      localIndex,
      contractRoot,
      contractIndex,
    })

    if (contractRoot === localRoot && contractIndex === localIndex) {
      logger.info('State is ok, no need to resync')
      return
    }

    const numTxs = Math.floor((contractIndex - localIndex) / OUTPLUSONE)
    if (numTxs < 0) {
      // TODO: rollback state
      throw new Error('State is corrupted, contract index is less than local index')
    }

    const missedIndices = Array(numTxs)
    for (let i = 0; i < numTxs; i++) {
      missedIndices[i] = localIndex + (i + 1) * OUTPLUSONE
    }

    const lastBlockNumber = (await this.getLastBlockToProcess()) + 1
    for await (const es of this.network.getEvents({
      contract: this.network.pool,
      startBlock,
      lastBlock: lastBlockNumber,
      event: 'Message',
      batchSize: this.config.eventsBatchSize,
    })) {
      for (const e of es) {
        // Filter pending txs in case of decentralized relay pool
        if (toBN(e.values.index).lte(toBN(contractIndex))) {
          await this.addTxToState(e.txHash, e.values.index, e.values.message)
        }
      }
    }

    const newLocalIndex = this.state.getNextIndex()
    const newLocalRoot = this.state.getMerkleRoot()
    logger.debug('Local state after update', {
      newLocalRoot,
      newLocalIndex,
    })
    if (newLocalRoot !== contractRoot) {
      throw new Error('State is corrupted, roots mismatch')
    }
  }

  async addTxToState(txHash: string, newPoolIndex: number, message: string) {
    const transactSelector = '0xaf989083'
    const directDepositSelector = '0x1dc4cb33'
    const transactV2Selector = '0x5fd28f8c'

    const input = await this.network.getTxCalldata(txHash)

    const prevPoolIndex = newPoolIndex - OUTPLUSONE
    const prevCommitIndex = Math.floor(Number(prevPoolIndex) / OUTPLUSONE)

    let outCommit: string
    let memo: string

    if (input.startsWith(directDepositSelector)) {
      // Direct deposit case
      const res = AbiCoder.decodeParameters(
        [
          'uint256', // Root after
          'uint256[]', // Indices
          'uint256', // Out commit
          'uint256[8]', // Deposit proof
          'uint256[8]', // Tree proof
        ],
        input.slice(10) // Cut off selector
      )
      outCommit = res[2]
      memo = truncateHexPrefix(message || '')
    } else if (input.startsWith(transactSelector)) {
      // Normal tx case
      const calldata = Buffer.from(truncateHexPrefix(input), 'hex')

      const parser = new PoolCalldataParser(calldata)

      outCommit = hexToNumberString(parser.getField('outCommit'))

      const txType = toTxType(parser.getField('txType'))

      const memoSize = hexToNumber(parser.getField('memoSize'))
      const memoRaw = truncateHexPrefix(parser.getField('memo', memoSize))

      memo = truncateMemoTxPrefix(memoRaw, txType)

      // Save nullifier in confirmed state
      const nullifier = parser.getField('nullifier')
      await this.state.nullifiers.add([hexToNumberString(nullifier)])
    } else if (input.startsWith(transactV2Selector)) {
      const calldata = Buffer.from(truncateHexPrefix(input), 'hex')

      const parser = new PoolCalldataV2Parser(calldata)

      outCommit = hexToNumberString(parser.getField('outCommit'))

      const txType = toTxType(parser.getField('txType'))

      const memoSize = hexToNumber(parser.getField('memoSize'))
      const memoRaw = truncateHexPrefix(parser.getField('memo', memoSize))

      memo = truncateMemoTxPrefixProverV2(memoRaw, txType)

      // Save nullifier in confirmed state
      const nullifier = parser.getField('nullifier')
      await this.state.nullifiers.add([hexToNumberString(nullifier)])
    } else {
      throw new Error(`Unknown transaction type: ${input}`)
    }

    const prefixedMemo = buildPrefixedMemo(outCommit, txHash, memo)
    for (let state of [this.state, this.optimisticState]) {
      state.addCommitment(prevCommitIndex, Helpers.strToNum(outCommit))
      state.addTx(prevPoolIndex, Buffer.from(prefixedMemo, 'hex'))
    }
  }

  verifyProof(proof: SnarkProof, inputs: Array<string>) {
    return Proof.verify(this.txVK, proof, inputs)
  }

  async getContractIndex() {
    const poolIndex = await this.network.pool.callRetry('pool_index')
    return Number(poolIndex)
  }

  async getContractMerkleRoot(index: string | number | undefined): Promise<string> {
    if (!index) {
      index = await this.getContractIndex()
      logger.info('CONTRACT INDEX %d', index)
    }
    const root = await this.network.pool.callRetry('roots', [index])
    return root.toString()
  }

  async getLimitsFor(address: string): Promise<Limits> {
    const limits = await this.network.accounting.callRetry('getLimitsFor', [address])
    return {
      tvlCap: toBN(limits.tvlCap),
      tvl: toBN(limits.tvl),
      dailyDepositCap: toBN(limits.dailyDepositCap),
      dailyDepositCapUsage: toBN(limits.dailyDepositCapUsage),
      dailyWithdrawalCap: toBN(limits.dailyWithdrawalCap),
      dailyWithdrawalCapUsage: toBN(limits.dailyWithdrawalCapUsage),
      dailyUserDepositCap: toBN(limits.dailyUserDepositCap),
      dailyUserDepositCapUsage: toBN(limits.dailyUserDepositCapUsage),
      depositCap: toBN(limits.depositCap),
      tier: toBN(limits.tier),
      dailyUserDirectDepositCap: toBN(limits.dailyUserDirectDepositCap),
      dailyUserDirectDepositCapUsage: toBN(limits.dailyUserDirectDepositCapUsage),
      directDepositCap: toBN(limits.directDepositCap),
    }
  }

  processLimits(limits: Limits): LimitsFetch {
    const limitsFetch = {
      deposit: {
        singleOperation: limits.depositCap.toString(10),
        dailyForAddress: {
          total: limits.dailyUserDepositCap.toString(10),
          available: limits.dailyUserDepositCap.sub(limits.dailyUserDepositCapUsage).toString(10),
        },
        dailyForAll: {
          total: limits.dailyDepositCap.toString(10),
          available: limits.dailyDepositCap.sub(limits.dailyDepositCapUsage).toString(10),
        },
        poolLimit: {
          total: limits.tvlCap.toString(10),
          available: limits.tvlCap.sub(limits.tvl).toString(10),
        },
      },
      withdraw: {
        dailyForAll: {
          total: limits.dailyWithdrawalCap.toString(10),
          available: limits.dailyWithdrawalCap.sub(limits.dailyWithdrawalCapUsage).toString(10),
        },
      },
      dd: {
        singleOperation: limits.directDepositCap.toString(10),
        dailyForAddress: {
          total: limits.dailyUserDirectDepositCap.toString(10),
          available: limits.dailyUserDirectDepositCap.sub(limits.dailyUserDirectDepositCapUsage).toString(10),
        },
      },
      tier: limits.tier.toString(10),
    }
    return limitsFetch
  }
}
