import BN from 'bn.js'
import { toBN, AbiItem } from 'web3-utils'
import { TxType, TxData, WithdrawTxData, PermittableDepositTxData, getTxData } from 'zp-memo-parser'
import { Proof, SnarkProof } from 'libzkbob-rs-node'
import { logger } from './services/appLogger'
import config from './config'
import type { Limits, Pool } from './pool'
import type { NullifierSet } from './state/nullifierSet'
import TokenAbi from './abi/token-abi.json'
import { web3 } from './services/web3'
import { numToHex, unpackSignature } from './utils/helpers'
import { recoverSaltedPermit } from './utils/EIP712SaltedPermit'
import { ZERO_ADDRESS } from './utils/constants'
import { TxPayload } from './queue/poolTxQueue'
import { getTxProofField, parseDelta } from './utils/proofInputs'
import type { PoolState } from './state/PoolState'

const tokenContract = new web3.eth.Contract(TokenAbi as AbiItem[], config.tokenAddress)

const ZERO = toBN(0)

export class TxValidationError extends Error {
  constructor(message: string) {
    super(message)
  }
}

type OptionError = Error | null
export async function checkAssertion(f: () => Promise<OptionError> | OptionError) {
  const err = await f()
  if (err) {
    throw err
  }
}

export function checkSize(data: string, size: number) {
  return data.length === size
}

export async function checkBalance(address: string, minBalance: string) {
  const balance = await tokenContract.methods.balanceOf(address).call()
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

export function checkTxSpecificFields(txType: TxType, tokenAmount: BN, energyAmount: BN, txData: TxData) {
  logger.debug(
    'TOKENS %s, ENERGY %s, TX DATA %s',
    tokenAmount.toString(),
    energyAmount.toString(),
    JSON.stringify(txData)
  )
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

export function checkNativeAmount(nativeAmount: BN | null) {
  logger.debug(`Native amount: ${nativeAmount}`)
  // Check native amount (relayer faucet)
  if (nativeAmount && nativeAmount > config.maxFaucet) {
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

/**
 * @param signedDeadline deadline signed by user, in seconds
 * @param threshold "window" added to curent relayer time, in seconds
 */
export function checkDeadline(signedDeadline: BN, threshold: number) {
  logger.debug(`Deadline: ${signedDeadline}`)
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

async function checkDepositEnoughBalance(address: string, requiredTokenAmount: BN) {
  if (requiredTokenAmount.lte(toBN(0))) {
    throw new TxValidationError('Requested balance check for token amount <= 0')
  }

  return checkBalance(address, requiredTokenAmount.toString(10))
}

async function getRecoveredAddress(
  txType: TxType,
  proofNullifier: string,
  txData: TxData,
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
    const { deadline, holder } = txData as PermittableDepositTxData
    const owner = web3.utils.toChecksumAddress(web3.utils.bytesToHex(Array.from(holder)))
    const spender = web3.utils.toChecksumAddress(config.poolAddress as string)
    const nonce = await tokenContract.methods.nonces(owner).call()

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
    throw new TxValidationError('Unsupported txtype')
  }

  return recoveredAddress
}

async function checkRoot(proofIndex: BN, proofRoot: string, state: PoolState) {
  const index = proofIndex.toNumber()

  const stateRoot = state.getMerkleRootAt(index)
  if (stateRoot !== proofRoot) {
    return new TxValidationError(`Incorrect root at index ${index}: given ${proofRoot}, expected ${stateRoot}`)
  }

  return null
}

export async function validateTx({ txType, rawMemo, txProof, depositSignature }: TxPayload, pool: Pool) {
  const buf = Buffer.from(rawMemo, 'hex')
  const txData = getTxData(buf, txType)

  const root = getTxProofField(txProof, 'root')
  const nullifier = getTxProofField(txProof, 'nullifier')
  const delta = parseDelta(getTxProofField(txProof, 'delta'))
  const fee = toBN(txData.fee)

  // prettier-ignore
  await checkAssertion(() => checkRoot(
    delta.transferIndex,
    root,
    pool.optimisticState,
  ))
  await checkAssertion(() => checkNullifier(nullifier, pool.state.nullifiers))
  await checkAssertion(() => checkNullifier(nullifier, pool.optimisticState.nullifiers))
  await checkAssertion(() => checkTransferIndex(toBN(pool.optimisticState.getNextIndex()), delta.transferIndex))

  await checkAssertion(() => checkFee(fee))

  if (txType === TxType.WITHDRAWAL) {
    const nativeAmount = (txData as WithdrawTxData).nativeAmount
    await checkAssertion(() => checkNativeAmount(toBN(nativeAmount)))
  }

  await checkAssertion(() => checkProof(txProof, (p, i) => pool.verifyProof(p, i)))

  const tokenAmountWithFee = delta.tokenAmount.add(fee)
  await checkAssertion(() => checkTxSpecificFields(txType, tokenAmountWithFee, delta.energyAmount, txData))

  const requiredTokenAmount = tokenAmountWithFee.mul(pool.denominator)
  let userAddress = ZERO_ADDRESS
  if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT) {
    userAddress = await getRecoveredAddress(txType, nullifier, txData, requiredTokenAmount, depositSignature)
    await checkAssertion(() => checkDepositEnoughBalance(userAddress, requiredTokenAmount))
  }
  if (txType === TxType.PERMITTABLE_DEPOSIT) {
    const deadline = (txData as PermittableDepositTxData).deadline
    await checkAssertion(() => checkDeadline(toBN(deadline), config.permitDeadlineThresholdInitial))
  }

  const limits = await pool.getLimitsFor(userAddress)
  await checkAssertion(() => checkLimits(limits, delta.tokenAmount))
}
