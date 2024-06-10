import { logger } from '@/lib/appLogger'
import { NetworkBackend } from '@/lib/network/NetworkBackend'
import { Network } from '@/lib/network/types'
import { redis } from '@/lib/redisClient'
import { BasePoolTx, JobState, PoolTx, poolTxQueue, WorkerTxType, WorkerTxTypePriority } from '@/queue/poolTxQueue'
import { PoolState } from '@/state/PoolState'
import { OUTPLUSONE } from '@/utils/constants'
import {
  buildPrefixedMemo,
  fetchJson,
  toTxType,
  truncateHexPrefix,
  truncateMemoTxPrefix,
  truncateMemoTxPrefixProverV2,
} from '@/utils/helpers'
import { PoolCalldataParser, PoolCalldataV2Parser } from '@/utils/PoolCalldataParser'
import { getBlockNumber } from '@/utils/web3'
import BN from 'bn.js'
import { Helpers, Proof, SnarkProof, VK } from 'libzkbob-rs-node'
import AbiCoder from 'web3-eth-abi'
import { hexToNumber, hexToNumberString, toBN } from 'web3-utils'
import type { BasePoolConfig, Limits, LimitsFetch, OptionalChecks, ProcessResult } from './types'

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

  abstract onSend(p: ProcessResult<any>, txHash: string): Promise<void>
  abstract onConfirmed(p: ProcessResult<any>, txHash: string, callback?: () => Promise<void>): Promise<void>

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

  buildTx(tx: PoolTx<WorkerTxType>): Promise<ProcessResult<any>> {
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
  buildNormalTx(tx: PoolTx<WorkerTxType.Normal>): Promise<ProcessResult<any>> {
    throw new Error('Method not implemented.')
  }
  buildDirectDepositTx(tx: PoolTx<WorkerTxType.DirectDeposit>): Promise<ProcessResult<any>> {
    throw new Error('Method not implemented.')
  }
  buildFinalizeTx(tx: PoolTx<WorkerTxType.Finalize>): Promise<ProcessResult<any>> {
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

  async syncState(startBlock?: number, indexerUrl?: string) {
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

    if (indexerUrl) {
      await this.syncStateFromIndexer(indexerUrl)
    } else if (startBlock) {
      await this.syncStateFromContract(startBlock, contractIndex, localIndex)
    } else {
      throw new Error('Either startBlock or indexerUrl should be provided for sync')
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

  async syncStateFromIndexer(indexerUrl: string) {
    let txs = []
    let commitIndex = this.optimisticState.getNextIndex() / OUTPLUSONE
    do {
      txs = await this.fetchTransactionsFromIndexer(indexerUrl, this.optimisticState.getNextIndex(), 200)
      for (const tx of txs) {
        const outCommit = hexToNumberString('0x' + tx.commitment)
        this.optimisticState.addCommitment(commitIndex, Helpers.strToNum(outCommit))
        if (tx.isMined) {
          this.state.addCommitment(commitIndex, Helpers.strToNum(outCommit))
        }
        commitIndex++
      }
    } while (txs.length !== 0)
  }

  async fetchTransactionsFromIndexer(indexerUrl: string, offset: number, limit: number) {
    const txs: string[] = await fetchJson(indexerUrl, '/transactions/v2', [
      ['offset', offset.toString()],
      ['limit', limit.toString()],
    ])

    return txs.map((tx, txIdx) => {
      // mined flag + txHash(32 bytes) + commitment(32 bytes) + memo
      return {
        isMined: tx.slice(0, 1) === '1',
        txHash: '0x' + tx.slice(1, 65),
        commitment: tx.slice(65, 129),
        index: offset + txIdx * OUTPLUSONE,
        memo: tx.slice(129),
      }
    })
  }

  async syncStateFromContract(startBlock: number, contractIndex: number, localIndex: number) {
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
    for await (const batch of this.network.getEvents({
      contract: this.network.pool,
      startBlock,
      lastBlock: lastBlockNumber,
      event: 'Message',
      batchSize: this.config.eventsBatchSize,
    })) {
      for (const e of batch.events) {
        // Filter pending txs in case of decentralized relay pool
        const state = toBN(e.values.index).lte(toBN(contractIndex)) ? 'all' : 'optimistic'
        await this.addTxToState(e.txHash, e.values.index, e.values.message, state)
      }
    }
  }

  async addTxToState(txHash: string, newPoolIndex: number, message: string, state: 'optimistic' | 'confirmed' | 'all') {
    const transactSelector = '0xaf989083'
    const transactV2Selector = '0x5fd28f8c'

    const directDepositOldSelector = '0x1dc4cb33'
    const directDepositSelector = '0xe6b14272'

    const input = await this.network.getTxCalldata(txHash)

    const prevPoolIndex = newPoolIndex - OUTPLUSONE
    const prevCommitIndex = Math.floor(Number(prevPoolIndex) / OUTPLUSONE)

    let outCommit: string
    let memo: string

    if (input.startsWith(directDepositSelector)) {
      // Direct deposit case
      const res = AbiCoder.decodeParameters(
        [
          'uint256[]', // Indices
          'uint256', // Out commit
          'uint256[8]', // Deposit proof
          'address', // Prover
        ],
        input.slice(10) // Cut off selector
      )
      outCommit = res[1]
      memo = truncateHexPrefix(message || '')
    } else if (input.startsWith(directDepositOldSelector)) {
      // Old direct deposit case
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
      if (state !== 'optimistic') {
        const nullifier = parser.getField('nullifier')
        await this.state.nullifiers.add([hexToNumberString(nullifier)])
      }
    } else if (input.startsWith(transactV2Selector)) {
      const calldata = Buffer.from(truncateHexPrefix(input), 'hex')

      const parser = new PoolCalldataV2Parser(calldata)

      outCommit = hexToNumberString(parser.getField('outCommit'))

      const txType = toTxType(parser.getField('txType'))

      const memoSize = hexToNumber(parser.getField('memoSize'))
      const memoRaw = truncateHexPrefix(parser.getField('memo', memoSize))

      memo = truncateMemoTxPrefixProverV2(memoRaw, txType)

      // Save nullifier in confirmed state
      if (state !== 'optimistic') {
        const nullifier = parser.getField('nullifier')
        await this.state.nullifiers.add([hexToNumberString(nullifier)])
      }
    } else {
      throw new Error(`Unknown transaction type: ${input}`)
    }

    const states = state === 'optimistic' ? [this.optimisticState] : [this.state, this.optimisticState]
    const prefixedMemo = buildPrefixedMemo(outCommit, txHash, memo)
    for (let state of states) {
      state.updateState(prevCommitIndex, outCommit, prefixedMemo)
    }
  }

  propagateOptimisticState(index: number) {
    index = Math.floor(index / OUTPLUSONE)
    const opIndex = Math.floor(this.optimisticState.getNextIndex() / OUTPLUSONE)
    const stateIndex = Math.floor(this.state.getNextIndex() / OUTPLUSONE)
    if (index > opIndex) {
      throw new Error('Index is greater than optimistic state index')
    }

    for (let i = stateIndex; i < index; i++) {
      const tx = this.optimisticState.getDbTx(i * OUTPLUSONE)
      if (!tx) {
        throw new Error(`Tx not found, index: ${i}`)
      }
      const outCommit = hexToNumberString('0x' + tx.slice(0, 64))
      this.state.updateState(i, outCommit, tx)
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
