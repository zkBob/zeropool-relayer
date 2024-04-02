import { logger } from '@/lib/appLogger'
import { PoolTx, WorkerTxType } from '@/queue/poolTxQueue'
import { ENERGY_SIZE, PERMIT2_CONTRACT, TOKEN_SIZE, TRANSFER_INDEX_SIZE } from '@/utils/constants'
import { encodeProof, numToHex, truncateHexPrefix, truncateMemoTxPrefixProverV2 } from '@/utils/helpers'
import { Permit2Recover, SaltedPermitRecover, TransferWithAuthorizationRecover } from '@/utils/permit'
import { PermitType, type PermitRecover } from '@/utils/permit/types'
import { getTxProofField, parseDelta } from '@/utils/proofInputs'
import {
  checkAddressEq,
  checkAssertion,
  checkCondition,
  checkMemoPrefixProverV2,
  checkPoolId,
  checkProof,
  TxValidationError,
} from '@/validation/tx/common'
import AbiCoder from 'web3-eth-abi'
import { bytesToHex, toBN } from 'web3-utils'
import { getTxDataProverV2, TxType } from 'zp-memo-parser'
import { BasePool } from './BasePool'
import { OptionalChecks, PermitConfig, ProcessResult } from './types'

const ZERO = toBN(0)

export class RelayPool extends BasePool {
  public permitRecover: PermitRecover | null = null
  private proxyAddress!: string

  async init(permitConfig: PermitConfig, proxyAddress: string) {
    if (this.isInitialized) return

    this.proxyAddress = proxyAddress

    this.denominator = toBN(await this.network.pool.call('denominator'))
    this.poolId = toBN(await this.network.pool.call('pool_id'))

    if (permitConfig.permitType === PermitType.SaltedPermit) {
      this.permitRecover = new SaltedPermitRecover(this.network, permitConfig.token)
    } else if (permitConfig.permitType === PermitType.Permit2) {
      this.permitRecover = new Permit2Recover(this.network, PERMIT2_CONTRACT)
    } else if (permitConfig.permitType === PermitType.TransferWithAuthorization) {
      this.permitRecover = new TransferWithAuthorizationRecover(this.network, permitConfig.token)
    } else if (permitConfig.permitType === PermitType.None) {
      this.permitRecover = null
    } else {
      throw new Error("Cannot infer pool's permit standard")
    }
    await this.permitRecover?.initializeDomain()

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
    const proxyAddress = bytesToHex(Array.from(txData.proxyAddress))
    const proverAddress = bytesToHex(Array.from(txData.proverAddress))

    logger.info('TxData', {
      deltaTokens: delta.tokenAmount.toString(10),
      deltaEnergy: delta.energyAmount.toString(10),
      transactFee: transactFee.toString(10),
      treeUpdateFee: treeUpdateFee.toString(10),
      proxyAddress,
      proverAddress,
    })

    await checkAssertion(() => checkAddressEq(proxyAddress, this.proxyAddress))

    await checkAssertion(() => checkPoolId(delta.poolId, this.poolId))
    await checkAssertion(() => checkProof(proof, (p, i) => this.verifyProof(p, i)))

    const tokenAmount = delta.tokenAmount
    const tokenAmountWithFee = tokenAmount.add(transactFee).add(treeUpdateFee)
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
  }: PoolTx<WorkerTxType.Normal>): Promise<ProcessResult<RelayPool>> {
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

  async onSend(p: ProcessResult<this>, txHash: string): Promise<void> {}

  async onConfirmed(res: ProcessResult<RelayPool>, txHash: string, callback?: () => Promise<void>): Promise<void> {}
}
