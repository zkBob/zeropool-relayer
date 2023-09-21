import BN from 'bn.js'
import { toBN } from 'web3-utils'
import type { Contract } from 'web3-eth-contract'
import { TxType, TxData, getTxData } from 'zp-memo-parser'
import { Proof, SnarkProof } from 'libzkbob-rs-node'
import { logger } from '@/services/appLogger'
import config from '@/configs/relayerConfig'
import type { Limits, Pool } from '@/pool'
import type { NullifierSet } from '@/state/nullifierSet'
import { web3 } from '@/services/web3'
import { applyDenominator, contractCallRetry, numToHex, truncateMemoTxPrefix, unpackSignature } from '@/utils/helpers'
import { ZERO_ADDRESS, MESSAGE_PREFIX_COMMON_V1, MOCK_CALLDATA } from '@/utils/constants'
import { getTxProofField, parseDelta } from '@/utils/proofInputs'
import type { TxPayload } from '@/queue/poolTxQueue'
import type { PoolState } from '@/state/PoolState'
import { checkAssertion, TxValidationError, checkSize, checkScreener, checkCondition } from './common'
import type { PermitRecover } from '@/utils/permit/types'
import type { FeeManager } from '@/services/fee'

const ZERO = toBN(0)

export async function checkBalance(token: Contract, address: string, minBalance: string) {
  const balance = await contractCallRetry(token, 'balanceOf', [address])
  const res = toBN(balance).gte(toBN(minBalance))
  if (!res) {
    return new TxValidationError('Not enough balance for deposit')
  }
  return null
}

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

export function checkNativeAmount(nativeAmount: BN | null, withdrawalAmount: BN) {
  logger.debug(`Native amount: ${nativeAmount}`)
  if (nativeAmount === null) {
    return null
  }
  if (nativeAmount.gt(config.maxNativeAmount) || nativeAmount.gt(withdrawalAmount)) {
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

async function checkDepositEnoughBalance(token: Contract, address: string, requiredTokenAmount: BN) {
  if (requiredTokenAmount.lte(toBN(0))) {
    throw new TxValidationError('Requested balance check for token amount <= 0')
  }

  return checkBalance(token, address, requiredTokenAmount.toString(10))
}

async function getRecoveredAddress<T extends TxType>(
  txType: T,
  proofNullifier: string,
  txData: TxData<T>,
  tokenContract: Contract,
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
    recoveredAddress = web3.eth.accounts.recover(nullifier, sig)
  } else if (txType === TxType.PERMITTABLE_DEPOSIT) {
    const { holder, deadline } = txData as TxData<TxType.PERMITTABLE_DEPOSIT>
    const spender = web3.utils.toChecksumAddress(config.poolAddress as string)
    const owner = web3.utils.toChecksumAddress(web3.utils.bytesToHex(Array.from(holder)))

    const recoverParams = {
      owner,
      deadline,
      spender,
      tokenContract,
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

export async function checkWithdrawalTransfer(token: Contract, address: string) {
  try {
    await token.methods.transfer(address, 0).call({
      from: config.poolAddress,
    })
  } catch (e) {
    return new TxValidationError(`Transfer simulation failed: ${(e as Error).message}`)
  }
  return null
}

export async function validateTx(
  { txType, rawMemo, txProof, depositSignature }: TxPayload,
  pool: Pool,
  feeManager: FeeManager,
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

  const tokenAmount = delta.tokenAmount
  const tokenAmountWithFee = tokenAmount.add(fee)
  const energyAmount = delta.energyAmount

  let nativeConvert = false
  let userAddress: string

  if (txType === TxType.WITHDRAWAL) {
    checkCondition(tokenAmountWithFee.lte(ZERO) && energyAmount.lte(ZERO), 'Incorrect withdraw amounts')

    const { nativeAmount, receiver } = txData as TxData<TxType.WITHDRAWAL>
    const nativeAmountBN = toBN(nativeAmount)
    userAddress = web3.utils.bytesToHex(Array.from(receiver))
    logger.info('Withdraw address: %s', userAddress)
    await checkAssertion(() => checkWithdrawalTransfer(pool.TokenInstance, userAddress))
    await checkAssertion(() => checkNativeAmount(nativeAmountBN, tokenAmountWithFee.neg()))

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
      pool.TokenInstance,
      requiredTokenAmount,
      depositSignature as string,
      pool.permitRecover
    )
    logger.info('Deposit address: %s', userAddress)
    await checkAssertion(() => checkDepositEnoughBalance(pool.TokenInstance, userAddress, requiredTokenAmount))
  } else if (txType === TxType.TRANSFER) {
    userAddress = config.relayerAddress
    checkCondition(tokenAmountWithFee.eq(ZERO) && energyAmount.eq(ZERO), 'Incorrect transfer amounts')
  } else {
    throw new TxValidationError('Unsupported TxType')
  }

  const requiredFee = await feeManager.estimateFee({
    txType,
    nativeConvert,
    txData: MOCK_CALLDATA + rawMemo + (depositSignature || ''),
  })
  const denominatedFee = requiredFee.denominate(pool.denominator).getEstimate()
  await checkAssertion(() => checkFee(fee, denominatedFee))

  const limits = await pool.getLimitsFor(userAddress)
  await checkAssertion(() => checkLimits(limits, delta.tokenAmount))

  if (txType === TxType.PERMITTABLE_DEPOSIT) {
    const { deadline } = txData as TxData<TxType.PERMITTABLE_DEPOSIT>
    logger.info('Deadline: %s', deadline)
    await checkAssertion(() => checkDeadline(toBN(deadline), config.permitDeadlineThresholdInitial))
  }

  if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT || txType === TxType.WITHDRAWAL) {
    await checkAssertion(() => checkScreener(userAddress, traceId))
  }
}
