import config from '@/configs/relayerConfig'
import { logger } from '@/lib/appLogger'
import { Network } from '@/lib/network'
import { redis } from '@/lib/redisClient'
import { JobState, PoolTx, poolTxQueue, WorkerTxType } from '@/queue/poolTxQueue'
import { TxStore } from '@/state/TxStore'
import { ENERGY_SIZE, MOCK_CALLDATA, PERMIT2_CONTRACT, TOKEN_SIZE, TRANSFER_INDEX_SIZE } from '@/utils/constants'
import {
  applyDenominator,
  buildPrefixedMemo,
  encodeProof,
  fetchJson,
  numToHex,
  truncateHexPrefix,
  truncateMemoTxPrefixProverV2,
} from '@/utils/helpers'
import { Permit2Recover, SaltedPermitRecover, TransferWithAuthorizationRecover } from '@/utils/permit'
import { PermitType, type PermitRecover } from '@/utils/permit/types'
import { getTxProofField, parseDelta } from '@/utils/proofInputs'
import {
  checkAddressEq,
  checkAssertion,
  checkCondition,
  checkDeadline,
  checkDepositEnoughBalance,
  checkFee,
  checkLimits,
  checkMemoPrefixProverV2,
  checkNativeAmount,
  checkNonZeroWithdrawAddress,
  checkNullifier,
  checkNullifierContract,
  checkPoolId,
  checkProof,
  checkRootIndexer,
  checkScreener,
  checkTransferIndex,
  getRecoveredAddress,
  TxValidationError,
} from '@/validation/tx/common'
import AbiCoder from 'web3-eth-abi'
import { bytesToHex, toBN } from 'web3-utils'
import { getTxDataProverV2, TxDataProverV2, TxType } from 'zp-memo-parser'
import { BasePool } from './BasePool'
import { OptionalChecks, PermitConfig, ProcessResult } from './types'

const ZERO = toBN(0)

export class RelayPool extends BasePool<Network> {
  public permitRecover: PermitRecover | null = null
  private proxyAddress!: string
  private indexerUrl!: string
  txStore!: TxStore

  async init(permitConfig: PermitConfig, proxyAddress: string, indexerUrl: string) {
    if (this.isInitialized) return

    this.txStore = new TxStore('tmp-tx-store', redis)

    this.proxyAddress = proxyAddress
    this.indexerUrl = indexerUrl

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

    const root = getTxProofField(proof, 'root')
    const nullifier = getTxProofField(proof, 'nullifier')
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

    const indexerInfo = await this.getIndexerInfo()

    await checkAssertion(() => checkAddressEq(proxyAddress, this.proxyAddress))
    await checkAssertion(() => checkPoolId(delta.poolId, this.poolId))
    await checkAssertion(() => checkRootIndexer(delta.transferIndex, root, this.indexerUrl))
    await checkAssertion(() => checkNullifier(nullifier, this.optimisticState.nullifiers))
    await checkAssertion(() => checkNullifierContract(nullifier, this.network))
    await checkAssertion(() => checkTransferIndex(toBN(indexerInfo.optimisticDeltaIndex), delta.transferIndex))
    await checkAssertion(() => checkProof(proof, (p, i) => this.verifyProof(p, i)))

    const tokenAmount = delta.tokenAmount
    const totalFee = transactFee.add(treeUpdateFee)
    const tokenAmountWithFee = tokenAmount.add(totalFee)
    const energyAmount = delta.energyAmount

    let nativeConvert = false
    let userAddress: string

    if (txType === TxType.WITHDRAWAL) {
      checkCondition(tokenAmountWithFee.lte(ZERO) && energyAmount.lte(ZERO), 'Incorrect withdraw amounts')

      const { nativeAmount, receiver } = txData as TxDataProverV2<TxType.WITHDRAWAL>
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
      userAddress = this.proxyAddress
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
      await checkAssertion(() => checkFee(totalFee, denominatedFee))
    }

    const limits = await this.getLimitsFor(userAddress)
    await checkAssertion(() => checkLimits(limits, delta.tokenAmount))

    if (txType === TxType.PERMITTABLE_DEPOSIT) {
      const { deadline } = txData as TxDataProverV2<TxType.PERMITTABLE_DEPOSIT>
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
    // TODO: we call indexer twice (during validation and tx build)
    const indexerInfo = await this.getIndexerInfo()

    return {
      data: calldata,
      func,
      outCommit,
      nullifier,
      memo: memoTruncated,
      // Commit index should be treated as an optimistic checkpoint
      // It can increase after the transaction is included
      commitIndex: indexerInfo.optimisticDeltaIndex,
    }
  }

  async onSend({ outCommit, nullifier, memo, commitIndex }: ProcessResult<RelayPool>, txHash: string): Promise<void> {
    const prefixedMemo = buildPrefixedMemo(
      outCommit,
      txHash,
      memo
    )

    await this.txStore.add(commitIndex, prefixedMemo)

    if (nullifier) {
      logger.debug('Adding nullifier %s to OS', nullifier)
      await this.optimisticState.nullifiers.add([nullifier])
    }
  }

  async onConfirmed(res: ProcessResult<RelayPool>, txHash: string, callback?: () => Promise<void>, jobId?: string): Promise<void> {
    logger.debug("Updating pool job %s completed, txHash %s", jobId, txHash);
    if(jobId) {
      const poolJob = await poolTxQueue.getJob(jobId);
      if (!poolJob) {
        logger.error('Pool job not found', { jobId });
      } else {
        poolJob.data.transaction.state = JobState.COMPLETED;
        poolJob.data.transaction.txHash = txHash;
        await poolJob.update(poolJob.data);
      }
    }
  }

  async getIndexerInfo() {
    const info = await fetchJson(this.indexerUrl, '/info', [])
    return info
  }
}
