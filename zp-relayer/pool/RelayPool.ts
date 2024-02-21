import config from '@/configs/relayerConfig'
import { logger } from '@/services/appLogger'
import { ENERGY_SIZE, OUTPLUSONE, PERMIT2_CONTRACT, TOKEN_SIZE, TRANSFER_INDEX_SIZE } from '@/utils/constants'
import { encodeProof, numToHex, sleep, truncateHexPrefix, truncateMemoTxPrefixProverV2 } from '@/utils/helpers'
import { getTxProofField, parseDelta } from '@/utils/proofInputs'
import AbiCoder from 'web3-eth-abi'
import { bytesToHex, toBN } from 'web3-utils'
import { TxType, getTxDataProverV2 } from 'zp-memo-parser'
import { BasePool, OptionalChecks, ProcessResult } from './BasePool'

import { PoolTx, WorkerTxType } from '@/queue/poolTxQueue'
import { Permit2Recover, SaltedPermitRecover, TransferWithAuthorizationRecover } from '@/utils/permit'
import { PermitType, type PermitRecover } from '@/utils/permit/types'
import {
  TxValidationError,
  checkAssertion,
  checkCondition,
  checkMemoPrefixProverV2,
  checkPoolId,
  checkProof,
} from '@/validation/tx/common'

const ZERO = toBN(0)

export class RelayPool extends BasePool {
  public permitRecover: PermitRecover | null = null

  async init(sync: boolean = true) {
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
    if (sync) {
      await this.syncState(config.COMMON_START_BLOCK)
    }
    this.isInitialized = true
  }

  async validateTx(
    { transaction: { memo, proof, txType, depositSignature } }: PoolTx<WorkerTxType.Normal>,
    optionalChecks: OptionalChecks = {},
    traceId?: string
  ): Promise<void> {
    // Additional checks for memo?
    await checkAssertion(() => checkMemoPrefixProverV2(memo, txType))

    const buf = Buffer.from(memo, 'hex')
    const txData = getTxDataProverV2(buf, txType)

    const delta = parseDelta(getTxProofField(proof, 'delta'))
    const transactFee = toBN(txData.transactFee)
    const treeUpdateFee = toBN(txData.treeUpdateFee)
    const proverAddress = bytesToHex(Array.from(txData.proverAddress))

    logger.info('TxData', {
      deltaTokens: delta.tokenAmount.toString(10),
      deltaEnergy: delta.energyAmount.toString(10),
      transactFee: transactFee.toString(10),
      treeUpdateFee: treeUpdateFee.toString(10),
      proverAddress,
    })

    await checkAssertion(() => checkPoolId(delta.poolId, this.poolId))
    await checkAssertion(() => checkProof(proof, (p, i) => this.verifyProof(p, i)))

    const tokenAmount = delta.tokenAmount
    const tokenAmountWithFee = tokenAmount.add(transactFee)
    const energyAmount = delta.energyAmount

    if (txType === TxType.WITHDRAWAL) {
      checkCondition(tokenAmountWithFee.lte(ZERO) && energyAmount.lte(ZERO), 'Incorrect withdraw amounts')
    } else if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT) {
      checkCondition(tokenAmount.gt(ZERO) && energyAmount.eq(ZERO), 'Incorrect deposit amounts')
      checkCondition(depositSignature !== null, 'Deposit signature is required')
    } else if (txType === TxType.TRANSFER) {
      checkCondition(tokenAmountWithFee.eq(ZERO) && energyAmount.eq(ZERO), 'Incorrect transfer amounts')
    } else {
      throw new TxValidationError('Unsupported TxType')
    }
  }

  async buildNormalTx({
    transaction: { proof, memo, depositSignature, txType },
  }: PoolTx<WorkerTxType.Normal>): Promise<ProcessResult> {
    const func = 'transactV2()'
    const version = 2

    const nullifier = getTxProofField(proof, 'nullifier')
    const outCommit = getTxProofField(proof, 'out_commit')
    const delta = parseDelta(getTxProofField(proof, 'delta'))

    const selector: string = AbiCoder.encodeFunctionSignature(func)

    let transferIndex = numToHex(delta.transferIndex, TRANSFER_INDEX_SIZE)
    let energyAmount = numToHex(delta.energyAmount, ENERGY_SIZE)
    let tokenAmount = numToHex(delta.tokenAmount, TOKEN_SIZE)

    const txFlatProof = encodeProof(proof.proof)

    const memoSize = numToHex(toBN(memo.length).divn(2), 4)

    const data = [
      selector,
      numToHex(toBN(version), 2),
      numToHex(toBN(nullifier)),
      numToHex(toBN(outCommit)),
      transferIndex,
      energyAmount,
      tokenAmount,
      txFlatProof,
      txType,
      memoSize,
      memo,
    ]

    if (depositSignature) {
      const signature = truncateHexPrefix(depositSignature)
      data.push(signature)
    }

    const calldata = data.join('')

    const memoTruncated = truncateMemoTxPrefixProverV2(memo, txType)

    const {
      pub: { root_after },
      commitIndex,
    } = this.optimisticState.getVirtualTreeProofInputs(outCommit)

    return {
      data: calldata,
      func,
      commitIndex,
      outCommit,
      nullifier,
      memo: memoTruncated,
      mpc: false,
      root: root_after,
    }
  }

  async onConfirmed(res: ProcessResult, txHash: string, callback?: () => Promise<void>): Promise<void> {
    // Start watching for prover to finalize the tree update
    ;(async () => {
      const poolIndex = (res.commitIndex + 1) * OUTPLUSONE
      while (true) {
        // TODO: until prover deadline is not reached
        // we can poll the job directly from prover
        const root = await this.network.pool.call('roots', [poolIndex]).then(toBN)

        if (!root.eq(ZERO)) {
          logger.debug('Tx is finalized', { poolIndex, root: root.toString(10) })
          await super.onConfirmed(res, txHash, callback)
          return
        } else {
          logger.debug('Waiting for prover to finalize the tree update', { poolIndex })
          await sleep(5000)
          continue
        }
      }
    })()
  }
}
