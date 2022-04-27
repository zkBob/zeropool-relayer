import './env'
import BN from 'bn.js'
import PoolAbi from './abi/pool-abi.json'
import { AbiItem, toBN } from 'web3-utils'
import { Contract } from 'web3-eth-contract'
import { config } from './config/config'
import { web3 } from './services/web3'
import { logger } from './services/appLogger'
import { txQueue } from './services/jobQueue'
import { OUTPLUSONE } from './utils/constants'
import { getEvents, getTransaction, getChainId } from './utils/web3'
import { PoolCalldataParser } from './utils/PoolCalldataParser'
import { readTransferNum, updateField, RelayerKeys } from './utils/redisFields'
import { numToHex, toTxType, truncateHexPrefix, truncateMemoTxPrefix } from './utils/helpers'
import {
  Params,
  TreePub,
  TreeSec,
  Proof,
  MerkleTree,
  TxStorage,
  MerkleProof,
  Constants,
  SnarkProof,
  VK,
  Helpers,
} from 'libzeropool-rs-node'
import {
  checkAssertion,
  checkNativeAmount,
  checkFee,
  checkNullifier,
  checkTransferIndex,
  checkTxProof,
  checkTxSpecificFields,
  parseDelta,
} from './validation'

import { getTxData, TxType } from 'zp-memo-parser'

class Pool {
  public PoolInstance: Contract
  private treeParams: Params
  private txVK: VK
  public tree: MerkleTree
  public txs: TxStorage
  public chainId: number = 0
  public denominator: BN = toBN(1)
  public isInitialized = false

  constructor() {
    this.PoolInstance = new web3.eth.Contract(PoolAbi as AbiItem[], config.poolAddress)

    this.treeParams = Params.fromFile(config.treeUpdateParamsPath)

    const txVK = require(config.txVKPath)
    this.txVK = txVK

    this.tree = new MerkleTree('./tree.db')
    this.txs = new TxStorage('./txs.db')
  }

  async init() {
    this.chainId = await getChainId(web3)
    this.denominator = toBN(await this.PoolInstance.methods.denominator().call())
    await this.syncState()
    this.isInitialized = true
  }

  async transact(txProof: Proof, rawMemo: string, txType: TxType = TxType.TRANSFER, depositSignature: string | null) {
    logger.debug('Adding tx job to queue')

    await checkAssertion(
      () => checkNullifier(txProof.inputs[1]),
      `Doublespend detected`
    )

    const buf = Buffer.from(rawMemo, 'hex')
    const { fee, nativeAmount } = getTxData(buf, txType)

    await checkAssertion(
      () => checkFee(fee),
      `Fee too low`
    )

    await checkAssertion(
      () => checkNativeAmount(nativeAmount),
      `Native amount too high`
    )

    await checkAssertion(
      () => checkTxProof(txProof),
      `Incorrect transfer proof`
    )

    const contractTransferIndex = await this.getContractTransferNum()
    const delta = parseDelta(txProof.inputs[3])

    await checkAssertion(
      () => checkTransferIndex(toBN(contractTransferIndex), delta.transferIndex),
      `Incorrect transfer index`
    )

    await checkAssertion(
      () => checkTxSpecificFields(
        txType,
        delta.tokenAmount,
        delta.energyAmount,
        nativeAmount,
        toBN('0')
      ),
      `Tx specific fields are incorrect`
    )

    // TODO maybe store memo in redis as a path to a file
    const created = Date.now()
    const job = await txQueue.add('test-tx', {
      to: config.poolAddress,
      amount: '0',
      gas: config.relayerGasLimit.toString(),
      txProof,
      txType,
      rawMemo,
      depositSignature,
      created
    })
    logger.debug(`Added job: ${job.id}`)
    return job.id
  }

  getVirtualTreeProof(outCommit: string, transferNum: number) {
    logger.debug(`Building virtual tree proof...`)
    const nextCommitIndex = Math.floor(transferNum / OUTPLUSONE)
    const prevCommitIndex = nextCommitIndex - 1

    const root_before = this.tree.getRoot()
    const root_after = this.tree.getVirtualNode(
      Constants.HEIGHT,
      0,
      [[[Constants.OUTLOG, nextCommitIndex], outCommit]],
      transferNum,
      transferNum + OUTPLUSONE
    )

    const proof_filled = this.tree.getCommitmentProof(prevCommitIndex)
    const proof_free = this.tree.getCommitmentProof(nextCommitIndex)

    const leaf = outCommit
    const prev_leaf = this.tree.getNode(Constants.OUTLOG, prevCommitIndex)

    logger.debug(`Virtual root ${root_after}; Commit ${outCommit}; Index ${nextCommitIndex}`)

    logger.debug('Proving tree...')
    const treePub = {
      root_before,
      root_after,
      leaf,
    }
    const treeSec = {
      proof_filled,
      proof_free,
      prev_leaf,
    }
    const proof = Proof.tree(
      this.treeParams,
      treePub,
      treeSec
    )
    logger.debug('Tree proved')

    return {
      proof,
      nextCommitIndex,
    }
  }

  addCommitment(index: number, commit: Buffer) {
    this.tree.addCommitment(index, commit)
  }

  getDbTx(i: number): [string, string] | null {
    const buf = this.txs.get(i)
    if (!buf) return null
    const data = buf.toString()
    const out_commit = data.slice(0, 64)
    const memo = data.slice(64)
    return [out_commit, memo]
  }

  async syncState(fromBlock: number | string = 'earliest') {
    logger.debug('Syncing state...')
    const contractRoot = await this.getContractMerkleRoot(null)
    let localRoot = this.getLocalMerkleRoot()
    logger.debug(`LATEST CONTRACT ROOT ${contractRoot}`)
    logger.debug(`LATEST LOCAL ROOT ${localRoot}`)
    if (contractRoot !== localRoot) {
      logger.debug('ROOT MISMATCH')

      // Zero out existing hashes
      const nextIndex = this.tree.getNextIndex()
      for (let i = 0; i < nextIndex; i++) {
        const emptyHash = Buffer.alloc(32)
        this.tree.addHash(i, emptyHash)
      }
      // Clear tx storage
      for (let i = 0; i < nextIndex; i += OUTPLUSONE) {
        this.txs.delete(i)
      }

      const events = await getEvents(this.PoolInstance, 'Message', { fromBlock })
      for (let txNum = 0; txNum < events.length; txNum++) {
        const { returnValues, transactionHash } = events[txNum]

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
        const commitAndMemo = numToHex(toBN(outCommit)).concat(truncatedMemo)

        this.addCommitment(txNum, Helpers.strToNum(outCommit))
        pool.txs.add(txNum * OUTPLUSONE, Buffer.from(commitAndMemo, 'hex'))
      }

      await updateField(RelayerKeys.TRANSFER_NUM, events.length * OUTPLUSONE)

      localRoot = this.getLocalMerkleRoot()
      logger.debug(`LATEST LOCAL ROOT AFTER UPDATE ${localRoot}`)
    }
  }

  getTreeProof(pub: TreePub, sec: TreeSec): Proof {
    return Proof.tree(this.treeParams, pub, sec)
  }

  verifyProof(proof: SnarkProof, inputs: Array<string>) {
    return Proof.verify(this.txVK, proof, inputs)
  }

  async getContractTransferNum() {
    const transferNum = await pool.PoolInstance.methods.pool_index().call()
    return Number(transferNum)
  }

  async getContractMerkleRoot(index: string | undefined | null): Promise<string> {
    if (!index) {
      index = await this.PoolInstance.methods.pool_index().call()
    }
    const root = await this.PoolInstance.methods.roots(index).call()
    return root.toString()
  }

  getLocalMerkleRoot(): string {
    return this.tree.getRoot()
  }

  getMerkleProof(noteIndex: number): MerkleProof {
    logger.debug(`Merkle proof for index ${noteIndex}`)
    return this.tree.getProof(noteIndex)
  }

  async getTransactions(limit: number, offset: number) {
    await this.syncState()
    const txs: string[] = []
    offset = Math.floor(offset / OUTPLUSONE) * OUTPLUSONE
    for (let i = 0; i < limit; i++) {
      const tx = this.txs.get(offset + i * OUTPLUSONE)
      if (tx) {
        txs[i] = tx.toString('hex')
      } else {
        break;
      }
    }
    return txs
  }
}

export const pool = new Pool()
