import config from '@/configs/relayerConfig'
import { logger } from '@/services/appLogger'
import { ENERGY_SIZE, MOCK_CALLDATA, PERMIT2_CONTRACT, TOKEN_SIZE, TRANSFER_INDEX_SIZE } from '@/utils/constants'
import {
  applyDenominator,
  encodeProof,
  flattenProof,
  numToHex,
  truncateHexPrefix,
  truncateMemoTxPrefix,
} from '@/utils/helpers'
import { getTxProofField, parseDelta } from '@/utils/proofInputs'
import { Proof } from 'libzkbob-rs-node'
import AbiCoder from 'web3-eth-abi'
import { bytesToHex, toBN } from 'web3-utils'
import { getTxData, TxData, TxType } from 'zp-memo-parser'
import { BasePool, OptionalChecks, ProcessResult } from './BasePool'

import type { Circuit, IProver } from '@/prover'
import { PoolTx, WorkerTxType } from '@/queue/poolTxQueue'
import { Permit2Recover, SaltedPermitRecover, TransferWithAuthorizationRecover } from '@/utils/permit'
import { PermitType, type PermitRecover } from '@/utils/permit/types'
import {
  checkAssertion,
  checkCondition,
  checkDeadline,
  checkDepositEnoughBalance,
  checkFee,
  checkLimits,
  checkMemoPrefix,
  checkNativeAmount,
  checkNonZeroWithdrawAddress,
  checkNullifier,
  checkPoolId,
  checkProof,
  checkRoot,
  checkScreener,
  checkTransferIndex,
  getRecoveredAddress,
  TxValidationError,
} from '@/validation/tx/common'

const ZERO = toBN(0)

export class DefaultPool extends BasePool {
  treeProver!: IProver<Circuit.Tree>
  public permitRecover: PermitRecover | null = null

  async init(sync: boolean = true, treeProver: IProver<Circuit.Tree>) {
    if (this.isInitialized) return

    this.treeProver = treeProver

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

  onIncluded(r: ProcessResult, txHash: string): Promise<void> {
    throw new Error('Method not implemented.')
  }

  async validateNormalTx(
    { transaction: { memo, proof, txType, depositSignature } }: PoolTx<WorkerTxType.Normal>,
    optionalChecks: OptionalChecks = {},
    traceId?: string
  ): Promise<void> {
    await checkAssertion(() => checkMemoPrefix(memo, txType))

    const buf = Buffer.from(memo, 'hex')
    const txData = getTxData(buf, txType)

    const root = getTxProofField(proof, 'root')
    const nullifier = getTxProofField(proof, 'nullifier')
    const delta = parseDelta(getTxProofField(proof, 'delta'))
    const fee = toBN(txData.transactFee)

    logger.info(
      'Delta tokens: %s, Energy tokens: %s, Fee: %s',
      delta.tokenAmount.toString(10),
      delta.energyAmount.toString(10),
      fee.toString(10)
    )

    await checkAssertion(() => checkPoolId(delta.poolId, this.poolId))
    await checkAssertion(() => checkRoot(delta.transferIndex, root, this.optimisticState))
    await checkAssertion(() => checkNullifier(nullifier, this.state.nullifiers))
    await checkAssertion(() => checkNullifier(nullifier, this.optimisticState.nullifiers))
    await checkAssertion(() => checkTransferIndex(toBN(this.optimisticState.getNextIndex()), delta.transferIndex))
    await checkAssertion(() => checkProof(proof, (p, i) => this.verifyProof(p, i)))
    if (optionalChecks.treeProof) {
      const { proof, vk } = optionalChecks.treeProof
      await checkAssertion(() => checkProof(proof, (p, i) => Proof.verify(vk, p, i)))
    }

    const tokenAmount = delta.tokenAmount
    const tokenAmountWithFee = tokenAmount.add(fee)
    const energyAmount = delta.energyAmount

    let nativeConvert = false
    let userAddress: string

    if (txType === TxType.WITHDRAWAL) {
      checkCondition(tokenAmountWithFee.lte(ZERO) && energyAmount.lte(ZERO), 'Incorrect withdraw amounts')

      const { nativeAmount, receiver } = txData as TxData<TxType.WITHDRAWAL>
      const nativeAmountBN = toBN(nativeAmount)
      userAddress = bytesToHex(Array.from(receiver))
      logger.info('Withdraw address: %s', userAddress)
      await checkAssertion(() => checkNonZeroWithdrawAddress(userAddress))
      await checkAssertion(() =>
        checkNativeAmount(nativeAmountBN, tokenAmountWithFee.neg(), config.RELAYER_MAX_NATIVE_AMOUNT)
      )

      if (!nativeAmountBN.isZero()) {
        nativeConvert = true
      }
    } else if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT) {
      checkCondition(tokenAmount.gt(ZERO) && energyAmount.eq(ZERO), 'Incorrect deposit amounts')
      checkCondition(depositSignature !== null, 'Deposit signature is required')

      const requiredTokenAmount = applyDenominator(tokenAmountWithFee, this.denominator)
      userAddress = await getRecoveredAddress(
        txType,
        nullifier,
        txData,
        this.network,
        requiredTokenAmount,
        depositSignature as string,
        this.permitRecover
      )
      logger.info('Deposit address: %s', userAddress)
      // TODO check for approve in case of deposit
      await checkAssertion(() => checkDepositEnoughBalance(this.network, userAddress, requiredTokenAmount))
    } else if (txType === TxType.TRANSFER) {
      userAddress = config.txManager.TX_ADDRESS
      checkCondition(tokenAmountWithFee.eq(ZERO) && energyAmount.eq(ZERO), 'Incorrect transfer amounts')
    } else {
      throw new TxValidationError('Unsupported TxType')
    }

    if (optionalChecks.fee) {
      const { feeManager } = optionalChecks.fee
      const requiredFee = await feeManager.estimateFee({
        txType,
        nativeConvert,
        txData: MOCK_CALLDATA + memo + (depositSignature || ''),
      })
      const denominatedFee = requiredFee.denominate(this.denominator).getEstimate()
      await checkAssertion(() => checkFee(fee, denominatedFee))
    }

    const limits = await this.getLimitsFor(userAddress)
    await checkAssertion(() => checkLimits(limits, delta.tokenAmount))

    if (txType === TxType.PERMITTABLE_DEPOSIT) {
      const { deadline } = txData as TxData<TxType.PERMITTABLE_DEPOSIT>
      logger.info('Deadline: %s', deadline)
      await checkAssertion(() => checkDeadline(toBN(deadline), config.RELAYER_PERMIT_DEADLINE_THRESHOLD_INITIAL))
    }

    if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT || txType === TxType.WITHDRAWAL) {
      if (optionalChecks.screener) {
        const { screenerUrl, screenerToken } = optionalChecks.screener
        await checkAssertion(() => checkScreener(userAddress, screenerUrl, screenerToken, traceId))
      }
    }
  }

  async getTreeProof(outCommit: string) {
    const { pub, sec, commitIndex } = this.optimisticState.getVirtualTreeProofInputs(outCommit)

    logger.debug(`Proving tree...`)
    const treeProof = await this.treeProver.prove(pub, sec)
    logger.debug(`Tree proved`)
    return { treeProof, commitIndex }
  }

  async buildNormalTx({
    transaction: { txType, proof, memo, depositSignature },
  }: PoolTx<WorkerTxType.Normal>): Promise<ProcessResult> {
    const func = 'transact()'

    const nullifier = getTxProofField(proof, 'nullifier')
    const outCommit = getTxProofField(proof, 'out_commit')
    const delta = parseDelta(getTxProofField(proof, 'delta'))

    const { treeProof, commitIndex } = await this.getTreeProof(outCommit)

    const rootAfter = treeProof.inputs[1]

    const selector: string = AbiCoder.encodeFunctionSignature(func)

    let transferIndex = numToHex(delta.transferIndex, TRANSFER_INDEX_SIZE)
    let energyAmount = numToHex(delta.energyAmount, ENERGY_SIZE)
    let tokenAmount = numToHex(delta.tokenAmount, TOKEN_SIZE)

    const txFlatProof = encodeProof(proof.proof)
    const treeFlatProof = encodeProof(treeProof.proof)

    const memoSize = numToHex(toBN(memo.length).divn(2), 4)

    const data = [
      selector,
      numToHex(toBN(nullifier)),
      numToHex(toBN(outCommit)),
      transferIndex,
      energyAmount,
      tokenAmount,
      txFlatProof,
      numToHex(toBN(rootAfter)),
      treeFlatProof,
      txType,
      memoSize,
      memo,
    ]

    if (depositSignature) {
      const signature = truncateHexPrefix(depositSignature)
      data.push(signature)
    }

    let calldata = data.join('')

    const memoTruncated = truncateMemoTxPrefix(memo, txType)

    return { data: calldata, func, commitIndex, outCommit, nullifier, memo: memoTruncated, mpc: false, root: rootAfter }
  }

  async buildDirectDepositTx({
    transaction: { outCommit, txProof, deposits, memo },
  }: PoolTx<WorkerTxType.DirectDeposit>): Promise<ProcessResult> {
    logger.info('Received direct deposit', { number: deposits.length })

    const func = 'appendDirectDeposits(uint256,uint256[],uint256,uint256[8],uint256[8])'

    const { treeProof, commitIndex } = await this.getTreeProof(outCommit)

    const rootAfter = treeProof.inputs[1]
    const indices = deposits.map(d => d.nonce)

    const data =
      AbiCoder.encodeFunctionSignature({} as any) +
      AbiCoder.encodeParameters(
        [],
        [rootAfter, indices, outCommit, flattenProof(txProof.proof), flattenProof(treeProof.proof)]
      ).slice(2)

    return { data, func, commitIndex, outCommit, memo, mpc: false, root: rootAfter }
  }

  async validateDirectDepositTx(
    tx: PoolTx<WorkerTxType.DirectDeposit>,
    _optionalChecks: OptionalChecks,
    _traceId: string | undefined
  ): Promise<void> {
    if (tx.transaction.deposits.length === 0) {
      throw new Error('Empty direct deposit batch, skipping')
    }
  }
}
