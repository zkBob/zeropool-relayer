import BN from 'bn.js'
import { toBN } from 'web3-utils'
import config from './configs/relayerConfig'
import { logger } from './services/appLogger'
import { redis } from './services/redisClient'
import { JobState, poolTxQueue, WorkerTxType, WorkerTxTypePriority } from './queue/poolTxQueue'
import { getBlockNumber, getEvents, getTransaction } from './utils/web3'
import { Helpers, Proof, SnarkProof, VK } from 'libzkbob-rs-node'
import { PoolState } from './state/PoolState'

import type { TxType } from 'zp-memo-parser'
import { buildPrefixedMemo, numToHex, toTxType, truncateHexPrefix, truncateMemoTxPrefix } from './utils/helpers'
import { PoolCalldataParser } from './utils/PoolCalldataParser'
import { OUTPLUSONE, PERMIT2_CONTRACT } from './utils/constants'
import { Permit2Recover, SaltedPermitRecover, TransferWithAuthorizationRecover } from './utils/permit'
import { PermitRecover, PermitType } from './utils/permit/types'
import { isEthereum, isTron, NetworkBackend } from './services/network/NetworkBackend'
import { Network } from './services/network/types'
import AbiCoder from 'web3-eth-abi'
import { hexToNumber, hexToNumberString } from 'web3-utils'

export interface PoolTx {
  proof: Proof
  memo: string
  txType: TxType
  depositSignature: string | null
}

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

export class Pool<N extends Network = Network> {
  private txVK: VK
  public state: PoolState
  public optimisticState: PoolState
  public denominator: BN = toBN(1)
  public poolId: BN = toBN(0)
  public isInitialized = false
  public permitRecover: PermitRecover | null = null

  constructor(public network: NetworkBackend<N>) {
    this.txVK = require(config.RELAYER_TX_VK_PATH)

    this.state = new PoolState('pool', redis, config.RELAYER_STATE_DIR_PATH)
    this.optimisticState = new PoolState('optimistic', redis, config.RELAYER_STATE_DIR_PATH)
  }

  loadState(states: { poolState: PoolState; optimisticState: PoolState }) {
    this.state = states.poolState
    this.optimisticState = states.optimisticState
  }

  async init() {
    if (this.isInitialized) return

    this.denominator = toBN(await this.network.pool.call('denominator'))
    this.poolId = toBN(await this.network.pool.call('pool_id'))

    if (config.RELAYER_PERMIT_TYPE === PermitType.SaltedPermit) {
      this.permitRecover = new SaltedPermitRecover(this.network, config.RELAYER_TOKEN_ADDRESS)
    } else if (config.RELAYER_PERMIT_TYPE === PermitType.Permit2) {
      this.permitRecover = new Permit2Recover(this.network, PERMIT2_CONTRACT)
    } else if (config.RELAYER_PERMIT_TYPE === PermitType.TransferWithAuthorization) {
      this.permitRecover = new TransferWithAuthorizationRecover(this.network, config.RELAYER_TOKEN_ADDRESS)
    } else if (config.RELAYER_PERMIT_TYPE === PermitType.None) {
      this.permitRecover = null
    } else {
      throw new Error("Cannot infer pool's permit standard")
    }
    await this.permitRecover?.initializeDomain()
    await this.syncState(config.COMMON_START_BLOCK)
    this.isInitialized = true
  }

  async transact(tx: PoolTx, traceId?: string) {
    const queueTx = {
      amount: '0',
      txProof: tx.proof,
      txType: tx.txType,
      rawMemo: tx.memo,
      depositSignature: tx.depositSignature,
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

    logger.debug(`LOCAL ROOT: ${localRoot}; LOCAL INDEX: ${localIndex}`)
    logger.debug(`CONTRACT ROOT: ${contractRoot}; CONTRACT INDEX: ${contractIndex}`)

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

    if (isEthereum(this.network)) {
      const lastBlockNumber = (await this.getLastBlockToProcess()) + 1
      let toBlock = startBlock
      for (let fromBlock = startBlock; toBlock < lastBlockNumber; fromBlock = toBlock) {
        toBlock = Math.min(toBlock + config.COMMON_EVENTS_PROCESSING_BATCH_SIZE, lastBlockNumber)
        const events = await getEvents(this.network.pool.instance, 'Message', {
          fromBlock,
          toBlock: toBlock - 1,
          filter: {
            index: missedIndices,
          },
        })

        for (let i = 0; i < events.length; i++) {
          await this.addTxToState(
            events[i].transactionHash,
            events[i].returnValues.index,
            events[i].returnValues.message
          )
        }
      }
    } else if (isTron(this.network)) {
      let fingerprint = null
      const MESSAGE_TOPIC = '7d39f8a6bc8929456fba511441be7361aa014ac6f8e21b99990ce9e1c7373536'
      do {
        const events = await this.network.tronWeb.getEventResult(this.network.pool.address(), {
          sinceTimestamp: 0,
          eventName: 'Message',
          onlyConfirmed: true,
          sort: 'block_timestamp',
          size: 200,
        })
        if (events.length === 0) {
          break
        }
        for (let i = 0; i < events.length; i++) {
          const txHash = events[i].transaction
          const txInfo = await this.network.tronWeb.trx.getTransactionInfo(txHash)
          const log = txInfo.log.find((l: any) => l.topics[0] === MESSAGE_TOPIC)
          const index = parseInt(log.topics[1], 16)
          const message = log.data
          await this.addTxToState(events[i].transaction, index, message)
        }
        fingerprint = events[events.length - 1].fingerprint || null
      } while (fingerprint !== null)
    }

    const newLocalRoot = this.state.getMerkleRoot()
    logger.debug(`LOCAL ROOT AFTER UPDATE ${newLocalRoot}`)
    if (newLocalRoot !== contractRoot) {
      logger.error('State is corrupted, roots mismatch')
    }
  }

  async addTxToState(txHash: string, newPoolIndex: number, message: string) {
    const transactSelector = '0xaf989083'
    const directDepositSelector = '0x1dc4cb33'

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

      const outCommitRaw = parser.getField('outCommit')
      outCommit = hexToNumberString(outCommitRaw)

      const txTypeRaw = parser.getField('txType')
      const txType = toTxType(txTypeRaw)

      const memoSize = hexToNumber(parser.getField('memoSize'))
      const memoRaw = truncateHexPrefix(parser.getField('memo', memoSize))

      memo = truncateMemoTxPrefix(memoRaw, txType)

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
    const limits = await this.network.pool.callRetry('getLimitsFor', [address])
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
