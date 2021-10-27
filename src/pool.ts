import './env'
import PoolAbi from './abi/pool-abi.json'
import { AbiItem } from 'web3-utils'
import { Contract } from 'web3-eth-contract'
import { config } from './config/config'
import { web3 } from './services/web3'
import { logger } from './services/appLogger'
import { txQueue } from './services/jobQueue'
import { OUTPLUSONE } from './utils/constants'
import { getEvents, getTransaction } from './utils/web3'
import { PoolCalldataParser } from './utils/PoolCalldataParser'
import { RelayerKeys, updateField } from './utils/redisFields'
import { numToHex, toTxType, truncateHexPrefix, truncateMemoTxPrefix, TxType } from './utils/helpers'
import {
  Params,
  TreePub,
  TreeSec,
  Proof,
  MerkleTree,
  TxStorage,
  MerkleProof,
  TransferPub,
  TransferSec,
  Constants,
  SnarkProof,
  VK,
  Helpers,
} from 'libzeropool-rs-node'
import txVK from '../transfer_verification_key.json'

class Pool {
  public PoolInstance: Contract
  private treeParams: Params
  private txParams: Params
  private txVK: VK
  public tree: MerkleTree
  public txs: TxStorage

  constructor() {
    this.PoolInstance = new web3.eth.Contract(PoolAbi as AbiItem[], config.poolAddress)

    this.treeParams = Params.fromFile('./tree_params.bin')
    this.txParams = Params.fromFile('./transfer_params.bin')

    this.txVK = txVK

    this.tree = new MerkleTree('./tree.db')
    this.txs = new TxStorage('./txs.db')

    this.syncState()
  }

  async transact(txProof: Proof, rawMemo: string, txType: TxType = TxType.TRANSFER, depositSignature: string | null) {
    logger.debug('Adding tx job to queue')
    // TODO maybe store memo in redis as a path to a file
    const job = await txQueue.add('test-tx', {
      to: config.poolAddress,
      amount: '0',
      gas: 5000000,
      txProof,
      txType,
      rawMemo,
      depositSignature,
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
    logger.debug('proved')

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
        const commitAndMemo = numToHex(outCommit).concat(truncatedMemo)

        this.addCommitment(txNum, Helpers.strToNum(outCommit))
        pool.txs.add(txNum * OUTPLUSONE, Buffer.from(commitAndMemo, 'hex'))
      }

      await updateField(RelayerKeys.TRANSFER_NUM, events.length * OUTPLUSONE)

      localRoot = this.getLocalMerkleRoot()
      logger.debug(`LATEST LOCAL ROOT AFTER UPDATE ${localRoot}`)
    }
  }

  getTxProof(pub: TransferPub, sec: TransferSec) {
    return Proof.tx(this.txParams, pub, sec)
  }

  getTreeProof(pub: TreePub, sec: TreeSec): Proof {
    return Proof.tree(this.treeParams, pub, sec)
  }

  verifyProof(proof: SnarkProof, inputs: Array<string>) {
    return Proof.verify(this.txVK, proof, inputs)
  }

  async getContractTransferNum() {
    const transferNum = await pool.PoolInstance.methods.transfer_num().call()
    return Number(transferNum)
  }

  async getContractMerkleRoot(index: string | undefined | null): Promise<string> {
    if (!index) {
      index = await this.PoolInstance.methods.transfer_num().call()
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

  getTransactions(limit: number, offset: number) {
    const txs: (Buffer | null)[] = new Array(limit)
    offset = Math.ceil(offset / OUTPLUSONE)
    for (let i = 0; i < limit; i++) {
      txs[i] = this.txs.get(offset + i * OUTPLUSONE)
    }
    return txs
  }
}

export const pool = new Pool()
