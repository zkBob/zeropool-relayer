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
import { contractCallRetry, numToHex, truncateMemoTxPrefix, unpackSignature } from '@/utils/helpers'
import { recoverSaltedPermit } from '@/utils/EIP712SaltedPermit'
import { ZERO_ADDRESS, MESSAGE_PREFIX_COMMON_V1 } from '@/utils/constants'
import { getTxProofField, parseDelta } from '@/utils/proofInputs'
import type { TxPayload } from '@/queue/poolTxQueue'
import type { PoolState } from '@/state/PoolState'
import { checkAssertion, TxValidationError, checkSize, checkScreener } from './common'

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

export function checkTxSpecificFields(txType: TxType, tokenAmount: BN, energyAmount: BN) {
  let isValid = false
  if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT) {
    isValid = tokenAmount.gte(ZERO) && energyAmount.eq(ZERO)
  } else if (txType === TxType.TRANSFER) {
    isValid = tokenAmount.eq(ZERO) && energyAmount.eq(ZERO)
  } else if (txType === TxType.WITHDRAWAL) {
    isValid = tokenAmount.lte(ZERO) && energyAmount.lte(ZERO)
  }
  if (!isValid) {
    return new TxValidationError('Tx specific fields are incorrect')
  }
  return null
}

export function checkNativeAmount(nativeAmount: BN | null, withdrawalAmount: BN) {
  logger.debug(`Native amount: ${nativeAmount}`)
  if (nativeAmount && (nativeAmount > config.maxNativeAmount || nativeAmount > withdrawalAmount)) {
    return new TxValidationError('Native amount too high')
  }
  return null
}

export function checkFee(fee: BN) {
  logger.debug(`Fee: ${fee}`)
  if (fee.lt(config.relayerFee)) {
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
  depositSignature: string | null
) {
  // Signature without `0x` prefix, size is 64*2=128
  await checkAssertion(() => {
    if (depositSignature !== null && checkSize(depositSignature, 128)) return null
    return new TxValidationError('Invalid deposit signature size')
  })
  const nullifier = '0x' + numToHex(toBN(proofNullifier))
  const sig = unpackSignature(depositSignature as string)

  let recoveredAddress: string
  if (txType === TxType.DEPOSIT) {
    recoveredAddress = web3.eth.accounts.recover(nullifier, sig)
  } else if (txType === TxType.PERMITTABLE_DEPOSIT) {
    const { deadline, holder } = txData as TxData<TxType.PERMITTABLE_DEPOSIT>
    const owner = web3.utils.toChecksumAddress(web3.utils.bytesToHex(Array.from(holder)))
    const spender = web3.utils.toChecksumAddress(config.poolAddress as string)
    const nonce = await contractCallRetry(tokenContract, 'nonces', [owner])

    const message = {
      owner,
      spender,
      value: tokenAmount.toString(10),
      nonce,
      deadline,
      salt: nullifier,
    }
    recoveredAddress = recoverSaltedPermit(message, sig)
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

export async function validateTx(
  { txType, rawMemo, txProof, depositSignature }: TxPayload,
  pool: Pool,
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
  await checkAssertion(() => checkFee(fee))
  await checkAssertion(() => checkProof(txProof, (p, i) => pool.verifyProof(p, i)))

  const tokenAmountWithFee = delta.tokenAmount.add(fee)
  await checkAssertion(() => checkTxSpecificFields(txType, tokenAmountWithFee, delta.energyAmount))

  let userAddress = ZERO_ADDRESS

  if (txType === TxType.WITHDRAWAL) {
    const { nativeAmount, receiver } = txData as TxData<TxType.WITHDRAWAL>
    userAddress = web3.utils.bytesToHex(Array.from(receiver))
    logger.info('Withdraw address: %s', userAddress)
    await checkAssertion(() => checkNonZeroWithdrawAddress(userAddress))
    await checkAssertion(() => checkNativeAmount(toBN(nativeAmount), tokenAmountWithFee))
  } else if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT) {
    const requiredTokenAmount = tokenAmountWithFee.mul(pool.denominator)
    userAddress = await getRecoveredAddress(
      txType,
      nullifier,
      txData,
      pool.TokenInstance,
      requiredTokenAmount,
      depositSignature
    )
    logger.info('Deposit address: %s', userAddress)
    await checkAssertion(() => checkDepositEnoughBalance(pool.TokenInstance, userAddress, requiredTokenAmount))
  }

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
