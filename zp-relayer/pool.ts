import './env'
import fs from 'fs'
import crypto from 'crypto'
import BN from 'bn.js'
import PoolAbi from './abi/pool-abi.json'
import { AbiItem, toBN } from 'web3-utils'
import { Contract } from 'web3-eth-contract'
import config from './config'
import { web3 } from './services/web3'
import { logger } from './services/appLogger'
import { redis } from './services/redisClient'
import { poolTxQueue } from './queue/poolTxQueue'
import { getBlockNumber, getEvents, getTransaction } from './utils/web3'
import { Helpers, Params, Proof, SnarkProof, VK } from 'libzkbob-rs-node'
import { PoolState } from './state/PoolState'

import { TxType } from 'zp-memo-parser'
import { numToHex, toTxType, truncateHexPrefix, truncateMemoTxPrefix } from './utils/helpers'
import { PoolCalldataParser } from './utils/PoolCalldataParser'
import { INIT_ROOT, OUTPLUSONE } from './utils/constants'

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
}

export interface LimitsFetch {
  deposit: {
    singleOperation: string
    daylyForAddress: {
      total: string
      available: string
    }
    daylyForAll: {
      total: string
      available: string
    }
    poolLimit: {
      total: string
      available: string
    }
  }
  withdraw: {
    daylyForAll: {
      total: string
      available: string
    }
  }
  tier: string
}

class Pool {
  public PoolInstance: Contract
  public treeParams: Params
  public treeParamsHash: string
  public transferParamsHash: string
  private txVK: VK
  public state: PoolState
  public optimisticState: PoolState
  public denominator: BN = toBN(1)
  public isInitialized = false

  constructor() {
    this.PoolInstance = new web3.eth.Contract(PoolAbi as AbiItem[], config.poolAddress)

    this.treeParamsHash = Pool.getHash(config.treeUpdateParamsPath)
    this.transferParamsHash = Pool.getHash(config.transferParamsPath)

    this.treeParams = Params.fromFile(config.treeUpdateParamsPath)
    const txVK = require(config.txVKPath)
    this.txVK = txVK

    this.state = new PoolState('pool', redis, config.stateDirPath)
    this.optimisticState = new PoolState('optimistic', redis, config.stateDirPath)
  }

  private static getHash(path: string) {
    const buffer = fs.readFileSync(path)
    const hash = crypto.createHash('sha256')
    hash.update(buffer)
    return hash.digest('hex')
  }

  async init() {
    if (this.isInitialized) return

    this.denominator = toBN(await this.PoolInstance.methods.denominator().call())
    await this.syncState(config.startBlock)
    this.isInitialized = true
  }

  async transact(txs: PoolTx[]) {
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
    const job = await poolTxQueue.add('tx', queueTxs)
    logger.debug(`Added job: ${job.id}`)
    return job.id
  }

  async getLastBlockToProcess() {
    const lastBlockNumber = await getBlockNumber(web3)
    return lastBlockNumber
  }

  async syncState(fromBlock: number) {
    logger.debug('Syncing state; starting from block %d', fromBlock)

    const localIndex = this.state.getNextIndex()
    const localRoot = this.state.getMerkleRoot()

    const contractIndex = await this.getContractIndex()
    const contractRoot = await this.getContractMerkleRoot(contractIndex)

    logger.debug(`LOCAL ROOT: ${localRoot}; LOCAL INDEX: ${localIndex}`)
    logger.debug(`CONTRACT ROOT: ${contractRoot}; CONTRACT INDEX: ${contractIndex}`)

    const rootSetRoot = await this.state.roots.get(localIndex.toString(10))
    logger.debug(`ROOT FROM ROOTSET: ${rootSetRoot}`)

    if (contractRoot === localRoot && rootSetRoot === localRoot && contractIndex === localIndex) {
      logger.info('State is ok, no need to resync')
      return
    }

    // Set initial root
    await this.state.roots.add({
      0: INIT_ROOT,
    })

    const numTxs = Math.floor((contractIndex - localIndex) / OUTPLUSONE)
    const missedIndices = Array(numTxs)
    for (let i = 0; i < numTxs; i++) {
      missedIndices[i] = localIndex + (i + 1) * OUTPLUSONE
    }

    const lastBlockNumber = await this.getLastBlockToProcess()
    let finishBlock = fromBlock
    for (let startBlock = fromBlock; finishBlock <= lastBlockNumber; startBlock = finishBlock) {
      finishBlock += config.eventsProcessingBatchSize
      const events = await getEvents(this.PoolInstance, 'Message', {
        fromBlock: startBlock,
        toBlock: finishBlock,
        filter: {
          index: missedIndices,
        },
      })

      for (let i = 0; i < events.length; i++) {
        const { returnValues, transactionHash } = events[i]
        const memoString: string = returnValues.message
        if (!memoString) {
          throw new Error('incorrect memo in event')
        }

        const { input } = await getTransaction(web3, transactionHash)
        const calldata = Buffer.from(truncateHexPrefix(input), 'hex')

        const parser = new PoolCalldataParser(calldata)

        const outCommitRaw = parser.getField('outCommit')
        const outCommit = web3.utils.hexToNumberString(outCommitRaw)

        const txTypeRaw = parser.getField('txType')
        const txType = toTxType(txTypeRaw)

        const memoSize = web3.utils.hexToNumber(parser.getField('memoSize'))
        const memoRaw = truncateHexPrefix(parser.getField('memo', memoSize))

        const truncatedMemo = truncateMemoTxPrefix(memoRaw, txType)
        const commitAndMemo = numToHex(toBN(outCommit)).concat(transactionHash.slice(2)).concat(truncatedMemo)

        const newPoolIndex = Number(returnValues.index)
        const prevPoolIndex = newPoolIndex - OUTPLUSONE
        const prevCommitIndex = Math.floor(Number(prevPoolIndex) / OUTPLUSONE)

        for (let state of [this.state, this.optimisticState]) {
          state.addCommitment(prevCommitIndex, Helpers.strToNum(outCommit))
          state.addTx(prevPoolIndex, Buffer.from(commitAndMemo, 'hex'))
        }

        // Save nullifier in confirmed state
        const nullifier = parser.getField('nullifier')
        await this.state.nullifiers.add([web3.utils.hexToNumberString(nullifier)])

        // Save root in confirmed state
        const root = this.state.getMerkleRoot()
        await this.state.roots.add({
          [newPoolIndex]: root,
        })
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
    const poolIndex = await this.PoolInstance.methods.pool_index().call()
    return Number(poolIndex)
  }

  async getContractMerkleRoot(index: string | number | undefined): Promise<string> {
    if (!index) {
      index = await this.getContractIndex()
      logger.info('CONTRACT INDEX %d', index)
    }
    const root = await this.PoolInstance.methods.roots(index).call()
    return root.toString()
  }

  async getLimitsFor(address: string): Promise<Limits> {
    const limits = await this.PoolInstance.methods.getLimitsFor(address).call()
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
    }
  }

  processLimits(limits: Limits): LimitsFetch {
    const limitsFetch = {
      deposit: {
        singleOperation: limits.depositCap.toString(10),
        daylyForAddress: {
          total: limits.dailyUserDepositCap.toString(10),
          available: limits.dailyUserDepositCap.sub(limits.dailyUserDepositCapUsage).toString(10),
        },
        daylyForAll: {
          total: limits.dailyDepositCap.toString(10),
          available: limits.dailyDepositCap.sub(limits.dailyDepositCapUsage).toString(10),
        },
        poolLimit: {
          total: limits.tvlCap.toString(10),
          available: limits.tvlCap.sub(limits.tvl).toString(10),
        },
      },
      withdraw: {
        daylyForAll: {
          total: limits.dailyWithdrawalCap.toString(10),
          available: limits.dailyWithdrawalCap.sub(limits.dailyWithdrawalCapUsage).toString(10),
        },
      },
      tier: limits.tier.toString(10),
    }
    return limitsFetch
  }
}

export const pool = new Pool()
export type { Pool }
