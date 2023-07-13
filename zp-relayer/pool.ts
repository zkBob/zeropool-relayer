import BN from 'bn.js'
import PoolAbi from './abi/pool-abi.json'
import TokenAbi from './abi/token-abi.json'
import { AbiItem, toBN } from 'web3-utils'
import type { Contract } from 'web3-eth-contract'
import config from './configs/relayerConfig'
import { web3 } from './services/web3'
import { logger } from './services/appLogger'
import { redis } from './services/redisClient'
import { poolTxQueue, WorkerTxType, WorkerTxTypePriority } from './queue/poolTxQueue'
import { getBlockNumber, getEvents, getTransaction } from './utils/web3'
import { Helpers, Proof, SnarkProof, VK } from 'libzkbob-rs-node'
import { PoolState } from './state/PoolState'

import type { TxType } from 'zp-memo-parser'
import { contractCallRetry, numToHex, toTxType, truncateHexPrefix, truncateMemoTxPrefix } from './utils/helpers'
import { PoolCalldataParser } from './utils/PoolCalldataParser'
import { OUTPLUSONE, PERMIT2_CONTRACT } from './utils/constants'
import { Permit2Recover, SaltedPermitRecover, TransferWithAuthorizationRecover } from './utils/permit'
import { PermitRecover, PermitType } from './utils/permit/types'

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

class Pool {
  public PoolInstance: Contract
  public TokenInstance: Contract
  private txVK: VK
  public state: PoolState
  public optimisticState: PoolState
  public denominator: BN = toBN(1)
  public poolId: BN = toBN(0)
  public isInitialized = false
  public permitRecover!: PermitRecover

  constructor() {
    this.PoolInstance = new web3.eth.Contract(PoolAbi as AbiItem[], config.poolAddress)
    this.TokenInstance = new web3.eth.Contract(TokenAbi as AbiItem[], config.tokenAddress)

    const txVK = require(config.txVKPath)
    this.txVK = txVK

    this.state = new PoolState('pool', redis, config.stateDirPath)
    this.optimisticState = new PoolState('optimistic', redis, config.stateDirPath)
  }

  loadState(states: { poolState: PoolState; optimisticState: PoolState }) {
    this.state = states.poolState
    this.optimisticState = states.optimisticState
  }

  async init() {
    if (this.isInitialized) return

    this.denominator = toBN(await this.PoolInstance.methods.denominator().call())
    this.poolId = toBN(await this.PoolInstance.methods.pool_id().call())

    if (config.permitType === PermitType.SaltedPermit) {
      this.permitRecover = new SaltedPermitRecover(web3, config.tokenAddress)
    } else if (config.permitType === PermitType.Permit2) {
      this.permitRecover = new Permit2Recover(web3, PERMIT2_CONTRACT)
    } else if (config.permitType === PermitType.TransferWithAuthorization) {
      this.permitRecover = new TransferWithAuthorizationRecover(web3, config.tokenAddress)
    } else {
      throw new Error("Cannot infer pool's permit standard")
    }
    await this.permitRecover.initializeDomain()

    await this.syncState(config.startBlock)
    this.isInitialized = true
  }

  async transact(txs: PoolTx[], traceId?: string) {
    const queueTxs = txs.map(({ proof, txType, memo, depositSignature }) => {
      return {
        amount: '0',
        gas: config.relayerGasLimit.toString(),
        txProof: proof,
        txType,
        rawMemo: memo,
        depositSignature,
      }
    })
    const job = await poolTxQueue.add(
      'tx',
      { type: WorkerTxType.Normal, transactions: queueTxs, traceId },
      {
        priority: WorkerTxTypePriority[WorkerTxType.Normal],
      }
    )
    logger.debug(`Added poolTxWorker job: ${job.id}`)
    return job.id
  }

  async getLastBlockToProcess() {
    const lastBlockNumber = await getBlockNumber(web3)
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
    const missedIndices = Array(numTxs)
    for (let i = 0; i < numTxs; i++) {
      missedIndices[i] = localIndex + (i + 1) * OUTPLUSONE
    }

    const transactSelector = '0xaf989083'
    const directDepositSelector = '0x1dc4cb33'

    const lastBlockNumber = (await this.getLastBlockToProcess()) + 1
    let toBlock = startBlock
    for (let fromBlock = startBlock; toBlock < lastBlockNumber; fromBlock = toBlock) {
      toBlock = Math.min(toBlock + config.eventsProcessingBatchSize, lastBlockNumber)
      const events = await getEvents(this.PoolInstance, 'Message', {
        fromBlock,
        toBlock: toBlock - 1,
        filter: {
          index: missedIndices,
        },
      })

      for (let i = 0; i < events.length; i++) {
        const { returnValues, transactionHash } = events[i]
        const { input } = await getTransaction(web3, transactionHash)

        const newPoolIndex = Number(returnValues.index)
        const prevPoolIndex = newPoolIndex - OUTPLUSONE
        const prevCommitIndex = Math.floor(Number(prevPoolIndex) / OUTPLUSONE)

        let outCommit: string
        let memo: string

        if (input.startsWith(directDepositSelector)) {
          // Direct deposit case
          const res = web3.eth.abi.decodeParameters(
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
          memo = truncateHexPrefix(returnValues.message || '')
        } else if (input.startsWith(transactSelector)) {
          // Normal tx case
          const calldata = Buffer.from(truncateHexPrefix(input), 'hex')

          const parser = new PoolCalldataParser(calldata)

          const outCommitRaw = parser.getField('outCommit')
          outCommit = web3.utils.hexToNumberString(outCommitRaw)

          const txTypeRaw = parser.getField('txType')
          const txType = toTxType(txTypeRaw)

          const memoSize = web3.utils.hexToNumber(parser.getField('memoSize'))
          const memoRaw = truncateHexPrefix(parser.getField('memo', memoSize))

          memo = truncateMemoTxPrefix(memoRaw, txType)

          // Save nullifier in confirmed state
          const nullifier = parser.getField('nullifier')
          await this.state.nullifiers.add([web3.utils.hexToNumberString(nullifier)])
        } else {
          throw new Error(`Unknown transaction type: ${input}`)
        }

        const commitAndMemo = numToHex(toBN(outCommit)).concat(transactionHash.slice(2)).concat(memo)
        for (let state of [this.state, this.optimisticState]) {
          state.addCommitment(prevCommitIndex, Helpers.strToNum(outCommit))
          state.addTx(prevPoolIndex, Buffer.from(commitAndMemo, 'hex'))
        }
      }
    }

    const newLocalRoot = this.state.getMerkleRoot()
    logger.debug(`LOCAL ROOT AFTER UPDATE ${newLocalRoot}`)
    if (newLocalRoot !== contractRoot) {
      logger.error('State is corrupted, roots mismatch')
    }
  }

  verifyProof(proof: SnarkProof, inputs: Array<string>) {
    return Proof.verify(this.txVK, proof, inputs)
  }

  async getContractIndex() {
    const poolIndex = await contractCallRetry(this.PoolInstance, 'pool_index')
    return Number(poolIndex)
  }

  async getContractMerkleRoot(index: string | number | undefined): Promise<string> {
    if (!index) {
      index = await this.getContractIndex()
      logger.info('CONTRACT INDEX %d', index)
    }
    const root = await contractCallRetry(this.PoolInstance, 'roots', [index])
    return root.toString()
  }

  async getLimitsFor(address: string): Promise<Limits> {
    const limits = await contractCallRetry(this.PoolInstance, 'getLimitsFor', [address])
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
      directDepositCap: toBN(limits.directDepositCap)
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
        }
      },
      tier: limits.tier.toString(10),
    }
    return limitsFetch
  }
}

export let pool: Pool = new Pool()

export type { Pool }
