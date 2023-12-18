import BN from 'bn.js'
import { toBN, toChecksumAddress, bytesToHex } from 'web3-utils'
import { TxType, TxData, getTxData } from 'zp-memo-parser'
import { Proof, SnarkProof, VK } from 'libzkbob-rs-node'
import { logger } from '@/services/appLogger'
import type { Limits, Pool } from '@/pool'
import type { NullifierSet } from '@/state/nullifierSet'
import { applyDenominator, numToHex, truncateMemoTxPrefix, unpackSignature } from '@/utils/helpers'
import { ZERO_ADDRESS, MESSAGE_PREFIX_COMMON_V1, MOCK_CALLDATA } from '@/utils/constants'
import { getTxProofField, parseDelta } from '@/utils/proofInputs'
import type { TxPayload } from '@/queue/poolTxQueue'
import type { PoolState } from '@/state/PoolState'
import { checkAssertion, TxValidationError, checkSize, checkScreener, checkCondition } from './common'
import type { PermitRecover } from '@/utils/permit/types'
import type { FeeManager } from '@/services/fee'
import type { NetworkBackend } from '@/services/network/NetworkBackend'
import type { Network, NetworkContract } from '@/services/network/types'

const ZERO = toBN(0)

export function checkCommitment(treeProof: Proof, txProof: Proof) {
  return treeProof.inputs[2] === txProof.inputs[2]
}

export function checkProof(txProof: Proof, verify: (p: SnarkProof, i: Array<string>) => boolean) {
  const res = verify(txProof.proof, txProof.inputs)
  if (!res) {
    return new TxValidationError('Incorrect snark proof')
  }
  return null
}

export async function checkNullifier(nullifier: string, nullifierSet: NullifierSet) {
  const inSet = await nullifierSet.isInSet(nullifier)
  if (inSet === 0) return null
  return new TxValidationError(`Doublespend detected in ${nullifierSet.name}`)
}

export function checkTransferIndex(contractPoolIndex: BN, transferIndex: BN) {
  if (transferIndex.lte(contractPoolIndex)) return null
  return new TxValidationError(`Incorrect transfer index`)
}

export function checkNativeAmount(nativeAmount: BN | null, withdrawalAmount: BN, maxNativeAmount: BN) {
  logger.debug(`Native amount: ${nativeAmount}`)
  if (nativeAmount === null) {
    return null
  }
  if (nativeAmount.gt(maxNativeAmount) || nativeAmount.gt(withdrawalAmount)) {
    return new TxValidationError('Native amount too high')
  }
  return null
}

export function checkFee(userFee: BN, requiredFee: BN) {
  logger.debug('Fee', {
    userFee: userFee.toString(),
    requiredFee: requiredFee.toString(),
  })
  if (userFee.lt(requiredFee)) {
    return new TxValidationError('Fee too low')
  }
  return null
}

export function checkNonZeroWithdrawAddress(address: string) {
  if (address === ZERO_ADDRESS) {
    return new TxValidationError('Withdraw address cannot be zero')
  }
  return null
}

/**
 * @param signedDeadline deadline signed by user, in seconds
 * @param threshold "window" added to current relayer time, in seconds
 */
export function checkDeadline(signedDeadline: BN, threshold: number) {
  // Check native amount (relayer faucet)
  const currentTimestamp = new BN(Math.floor(Date.now() / 1000))
  if (signedDeadline <= currentTimestamp.addn(threshold)) {
    return new TxValidationError(`Deadline is expired`)
  }
  return null
}

export function checkLimits(limits: Limits, amount: BN) {
  if (amount.gt(toBN(0))) {
    if (amount.gt(limits.depositCap)) {
      return new TxValidationError('Single deposit cap exceeded')
    }
    if (limits.tvl.add(amount).gte(limits.tvlCap)) {
      return new TxValidationError('Tvl cap exceeded')
    }
    if (limits.dailyUserDepositCapUsage.add(amount).gt(limits.dailyUserDepositCap)) {
      return new TxValidationError('Daily user deposit cap exceeded')
    }
    if (limits.dailyDepositCapUsage.add(amount).gt(limits.dailyDepositCap)) {
      return new TxValidationError('Daily deposit cap exceeded')
    }
  } else {
    if (limits.dailyWithdrawalCapUsage.sub(amount).gt(limits.dailyWithdrawalCap)) {
      return new TxValidationError('Daily withdrawal cap exceeded')
    }
  }
  return null
}

async function checkDepositEnoughBalance(network: NetworkBackend<Network>, address: string, requiredTokenAmount: BN) {
  if (requiredTokenAmount.lte(toBN(0))) {
    throw new TxValidationError('Requested balance check for token amount <= 0')
  }
  const balance = await network.token.callRetry('balanceOf', [address])
  const res = toBN(balance).gte(requiredTokenAmount)
  if (!res) {
    return new TxValidationError('Not enough balance for deposit')
  }
  return null
}

async function getRecoveredAddress<T extends TxType, N extends Network>(
  txType: T,
  proofNullifier: string,
  txData: TxData<T>,
  network: NetworkBackend<N>,
  tokenAmount: BN,
  depositSignature: string,
  permitRecover: PermitRecover
) {
  // Signature without `0x` prefix, size is 64*2=128
  checkCondition(checkSize(depositSignature, 128), 'Invalid deposit signature size')

  const nullifier = '0x' + numToHex(toBN(proofNullifier))
  const sig = unpackSignature(depositSignature)

  let recoveredAddress: string
  if (txType === TxType.DEPOSIT) {
    recoveredAddress = await network.recover(nullifier, sig)
  } else if (txType === TxType.PERMITTABLE_DEPOSIT) {
    if (permitRecover === null) {
      throw new TxValidationError('Permittable deposits are not enabled')
    }

    const { holder, deadline } = txData as TxData<TxType.PERMITTABLE_DEPOSIT>
    const spender = toChecksumAddress(network.pool.address())
    const owner = toChecksumAddress(bytesToHex(Array.from(holder)))

    const recoverParams = {
      owner,
      deadline,
      spender,
      tokenContract: network.token,
      amount: tokenAmount.toString(10),
      nullifier,
    }
    const preconditionRes = await permitRecover.precondition(recoverParams)
    if (preconditionRes !== null) {
      throw new TxValidationError(`Invalid permit precondition: ${preconditionRes.message}`)
    }
    recoveredAddress = await permitRecover.recoverPermitSignature(recoverParams, sig)
    if (recoveredAddress.toLowerCase() !== owner.toLowerCase()) {
      throw new TxValidationError(`Invalid deposit signer; Restored: ${recoveredAddress}; Expected: ${owner}`)
    }
  } else {
    throw new TxValidationError('Unsupported TxType')
  }

  return recoveredAddress
}

function checkRoot(proofIndex: BN, proofRoot: string, state: PoolState) {
  const index = proofIndex.toNumber()

  const stateRoot = state.getMerkleRootAt(index)
  if (stateRoot !== proofRoot) {
    return new TxValidationError(`Incorrect root at index ${index}: given ${proofRoot}, expected ${stateRoot}`)
  }

  return null
}

function checkPoolId(deltaPoolId: BN, contractPoolId: BN) {
  if (deltaPoolId.eq(contractPoolId)) {
    return null
  }
  return new TxValidationError(`Incorrect poolId: given ${deltaPoolId}, expected ${contractPoolId}`)
}

function checkMemoPrefix(memo: string, txType: TxType) {
  const numItemsSuffix = truncateMemoTxPrefix(memo, txType).substring(4, 8)
  if (numItemsSuffix === MESSAGE_PREFIX_COMMON_V1) {
    return null
  }
  return new TxValidationError(`Memo prefix is incorrect: ${numItemsSuffix}`)
}

export interface OptionalChecks {
  treeProof?: {
    proof: Proof
    vk: VK
  }
  fee?: {
    feeManager: FeeManager
  }
  screener?: {
    screenerUrl: string
    screenerToken: string
  }
}

export async function validateTx(
  { txType, rawMemo, txProof, depositSignature }: TxPayload,
  pool: Pool,
  relayerAddress: string,
  permitDeadlineThreshold: number,
  maxNativeAmount: BN,
  optionalChecks: OptionalChecks = {},
  traceId?: string
) {
  await checkAssertion(() => checkMemoPrefix(rawMemo, txType))

  const buf = Buffer.from(rawMemo, 'hex')
  const txData = getTxData(buf, txType)

  const root = getTxProofField(txProof, 'root')
  const nullifier = getTxProofField(txProof, 'nullifier')
  const delta = parseDelta(getTxProofField(txProof, 'delta'))
  const fee = toBN(txData.fee)

  logger.info(
    'Delta tokens: %s, Energy tokens: %s, Fee: %s',
    delta.tokenAmount.toString(10),
    delta.energyAmount.toString(10),
    fee.toString(10)
  )

  await checkAssertion(() => checkPoolId(delta.poolId, pool.poolId))
  await checkAssertion(() => checkRoot(delta.transferIndex, root, pool.optimisticState))
  await checkAssertion(() => checkNullifier(nullifier, pool.state.nullifiers))
  await checkAssertion(() => checkNullifier(nullifier, pool.optimisticState.nullifiers))
  await checkAssertion(() => checkTransferIndex(toBN(pool.optimisticState.getNextIndex()), delta.transferIndex))
  await checkAssertion(() => checkProof(txProof, (p, i) => pool.verifyProof(p, i)))
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
    await checkAssertion(() => checkNativeAmount(nativeAmountBN, tokenAmountWithFee.neg(), maxNativeAmount))

    if (!nativeAmountBN.isZero()) {
      nativeConvert = true
    }
  } else if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT) {
    checkCondition(tokenAmount.gt(ZERO) && energyAmount.eq(ZERO), 'Incorrect deposit amounts')
    checkCondition(depositSignature !== null, 'Deposit signature is required')

    const requiredTokenAmount = applyDenominator(tokenAmountWithFee, pool.denominator)
    userAddress = await getRecoveredAddress(
      txType,
      nullifier,
      txData,
      pool.network,
      requiredTokenAmount,
      depositSignature as string,
      pool.permitRecover
    )
    logger.info('Deposit address: %s', userAddress)
    // TODO check for approve in case of deposit
    await checkAssertion(() => checkDepositEnoughBalance(pool.network, userAddress, requiredTokenAmount))
  } else if (txType === TxType.TRANSFER) {
    userAddress = relayerAddress
    checkCondition(tokenAmountWithFee.eq(ZERO) && energyAmount.eq(ZERO), 'Incorrect transfer amounts')
  } else {
    throw new TxValidationError('Unsupported TxType')
  }

  if (optionalChecks.fee) {
    const { feeManager } = optionalChecks.fee
    const requiredFee = await feeManager.estimateFee({
      txType,
      nativeConvert,
      txData: MOCK_CALLDATA + rawMemo + (depositSignature || ''),
    })
    const denominatedFee = requiredFee.denominate(pool.denominator).getEstimate()
    await checkAssertion(() => checkFee(fee, denominatedFee))
  }

  const limits = await pool.getLimitsFor(userAddress)
  await checkAssertion(() => checkLimits(limits, delta.tokenAmount))

  if (txType === TxType.PERMITTABLE_DEPOSIT) {
    const { deadline } = txData as TxData<TxType.PERMITTABLE_DEPOSIT>
    logger.info('Deadline: %s', deadline)
    await checkAssertion(() => checkDeadline(toBN(deadline), permitDeadlineThreshold))
  }

  if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT || txType === TxType.WITHDRAWAL) {
    if (optionalChecks.screener) {
      const { screenerUrl, screenerToken } = optionalChecks.screener
      await checkAssertion(() => checkScreener(userAddress, screenerUrl, screenerToken, traceId))
    }
  }
}

export type TxDataMPC = {
  txProof: Proof
  treeProof: Proof
  memo: string
  depositSignature: string | null
  txType: TxType
}

export async function validateTxMPC(
  { memo: rawMemo, txType, txProof, depositSignature, treeProof }: TxDataMPC,
  relayerAddress: string,
  poolContract: NetworkContract<Network>,
  poolId: BN,
  denominator: BN,
  treeVK: VK,
  txVK: VK
) {
  await checkAssertion(() => checkMemoPrefix(rawMemo, txType))

  const buf = Buffer.from(rawMemo, 'hex')
  const txData = getTxData(buf, txType)

  const root = getTxProofField(txProof, 'root')
  const nullifier = getTxProofField(txProof, 'nullifier')
  const delta = parseDelta(getTxProofField(txProof, 'delta'))
  const fee = toBN(txData.fee)

  logger.info(
    'Delta tokens: %s, Energy tokens: %s, Fee: %s',
    delta.tokenAmount.toString(10),
    delta.energyAmount.toString(10),
    fee.toString(10)
  )

  await checkAssertion(() => checkPoolId(delta.poolId, poolId))
  await checkAssertion(async () => {
    const res = await poolContract.callRetry('roots', [delta.transferIndex])
    if (res !== root) {
      return new TxValidationError(`Incorrect root at index ${delta.transferIndex}: given ${root}, expected ${res}`)
    }
    return null
  })
  await checkAssertion(async () => {
    const res = await poolContract.callRetry('nullifiers', [nullifier])
    if (res !== '0') {
      return new TxValidationError(`DoubleSpend detected in contract`)
    }
    return null
  })
  // TODO: handle index
  // await checkAssertion(() => checkTransferIndex(toBN(pool.optimisticState.getNextIndex()), delta.transferIndex))
  await checkAssertion(() => checkProof(txProof, (p, i) => Proof.verify(txVK, p, i)))
  await checkAssertion(() => checkProof(treeProof, (p, i) => Proof.verify(treeVK, p, i)))

  const tokenAmount = delta.tokenAmount
  const tokenAmountWithFee = tokenAmount.add(fee)
  const energyAmount = delta.energyAmount

  let userAddress: string

  if (txType === TxType.WITHDRAWAL) {
    checkCondition(tokenAmountWithFee.lte(ZERO) && energyAmount.lte(ZERO), 'Incorrect withdraw amounts')

    const { receiver } = txData as TxData<TxType.WITHDRAWAL>
    userAddress = bytesToHex(Array.from(receiver))
    logger.info('Withdraw address: %s', userAddress)
    await checkAssertion(() => checkNonZeroWithdrawAddress(userAddress))
  } else if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT) {
    checkCondition(tokenAmount.gt(ZERO) && energyAmount.eq(ZERO), 'Incorrect deposit amounts')
    checkCondition(depositSignature !== null, 'Deposit signature is required')

    const requiredTokenAmount = applyDenominator(tokenAmountWithFee, denominator)
    // userAddress = await getRecoveredAddress(
    //   txType,
    //   nullifier,
    //   txData,
    //   pool.network,
    //   requiredTokenAmount,
    //   depositSignature as string,
    //   pool.permitRecover
    // )
    // logger.info('Deposit address: %s', userAddress)
    // TODO check for approve in case of deposit
    // await checkAssertion(() => checkDepositEnoughBalance(pool.network, userAddress, requiredTokenAmount))
  } else if (txType === TxType.TRANSFER) {
    userAddress = relayerAddress
    checkCondition(tokenAmountWithFee.eq(ZERO) && energyAmount.eq(ZERO), 'Incorrect transfer amounts')
  } else {
    throw new TxValidationError('Unsupported TxType')
  }

  // const limits = await pool.getLimitsFor(userAddress)
  // await checkAssertion(() => checkLimits(limits, delta.tokenAmount))
}
