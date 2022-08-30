import './env'
import BN from 'bn.js'
import PoolAbi from './abi/pool-abi.json'
import { AbiItem, toBN } from 'web3-utils'
import { Contract } from 'web3-eth-contract'
import config from './config'
import { web3 } from './services/web3'
import { logger } from './services/appLogger'
import { poolTxQueue } from './queue/poolTxQueue'
import { getEvents, getTransaction } from './utils/web3'
import { Helpers, Params, Proof, SnarkProof, VK } from 'libzkbob-rs-node'
import { validateTx } from './validateTx'
import { PoolState } from './state'

import { TxType } from 'zp-memo-parser'
import { numToHex, toTxType, truncateHexPrefix, truncateMemoTxPrefix } from './utils/helpers'
import { PoolCalldataParser } from './utils/PoolCalldataParser'
import { OUTPLUSONE } from './utils/constants'

export interface PoolTx {
  proof: Proof
  memo: string
  txType: TxType
  depositSignature: string | null
}

class Pool {
  public PoolInstance: Contract
  public treeParams: Params
  private txVK: VK
  public state: PoolState
  public optimisticState: PoolState
  public denominator: BN = toBN(1)
  public isInitialized = false

  constructor() {
    this.PoolInstance = new web3.eth.Contract(PoolAbi as AbiItem[], config.poolAddress)

    this.treeParams = Params.fromFile(config.treeUpdateParamsPath)
    const txVK = require(config.txVKPath)
    this.txVK = txVK

    this.state = new PoolState('pool')
    this.optimisticState = new PoolState('optimistic')
  }

  async init() {
    if (this.isInitialized) return

    this.denominator = toBN(await this.PoolInstance.methods.denominator().call())
    await this.syncState()
    this.isInitialized = true
  }

  async transact(txs: PoolTx[]) {
    for (const tx of txs) {
      await validateTx(tx)
    }

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

  async syncState(fromBlock: number | string = 'earliest') {
    logger.debug('Syncing state...')

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

    const events = await getEvents(this.PoolInstance, 'Message', {
      fromBlock,
      filter: {
        index: missedIndices,
      },
    })

    if (events.length !== missedIndices.length) {
      logger.error('Not all events found')
      return
    }

    for (let i = 0; i < events.length; i++) {
      const { returnValues, transactionHash } = events[i]
      const memoString: string = returnValues.message
      if (!memoString) {
        throw new Error('incorrect memo in event')
      }

      const { input } = await getTransaction(web3, transactionHash)
      const calldata = Buffer.from(truncateHexPrefix(input), 'hex')

      const parser = new PoolCalldataParser(calldata)

      const nullifier = parser.getField('nullifier')
      await this.state.nullifiers.add([web3.utils.hexToNumberString(nullifier)])

      const outCommitRaw = parser.getField('outCommit')
      const outCommit = web3.utils.hexToNumberString(outCommitRaw)

      const txTypeRaw = parser.getField('txType')
      const txType = toTxType(txTypeRaw)

      const memoSize = web3.utils.hexToNumber(parser.getField('memoSize'))
      const memoRaw = truncateHexPrefix(parser.getField('memo', memoSize))

      const truncatedMemo = truncateMemoTxPrefix(memoRaw, txType)
      const commitAndMemo = numToHex(toBN(outCommit)).concat(transactionHash.slice(2)).concat(truncatedMemo)

      const index = Number(returnValues.index) - OUTPLUSONE
      for (let state of [this.state, this.optimisticState]) {
        state.addCommitment(Math.floor(index / OUTPLUSONE), Helpers.strToNum(outCommit))
        state.addTx(index, Buffer.from(commitAndMemo, 'hex'))
      }
    }

    logger.debug(`LOCAL ROOT AFTER UPDATE ${this.state.getMerkleRoot()}`)
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
}

export const pool = new Pool()
export type { Pool }
