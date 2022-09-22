import BN from 'bn.js'
import { toBN, AbiItem } from 'web3-utils'
import { TxType, TxData, WithdrawTxData, PermittableDepositTxData, getTxData } from 'zp-memo-parser'
import { Helpers, Proof } from 'libzkbob-rs-node'
import { logger } from './services/appLogger'
import config from './config'
import { Limits, pool, PoolTx } from './pool'
import { NullifierSet } from './nullifierSet'
import TokenAbi from './abi/token-abi.json'
import { web3 } from './services/web3'
import { numToHex, unpackSignature } from './utils/helpers'
import { recoverSaltedPermit } from './utils/EIP712SaltedPermit'
import { ZERO_ADDRESS } from './utils/constants'
import { TxPayload } from './queue/poolTxQueue'

const tokenContract = new web3.eth.Contract(TokenAbi as AbiItem[], config.tokenAddress)

const ZERO = toBN(0)

export interface Delta {
  transferIndex: BN
  energyAmount: BN
  tokenAmount: BN
  poolId: BN
}

type OptionError = Error | null
export async function checkAssertion(f: () => Promise<OptionError> | OptionError) {
  const err = await f()
  if (err) {
    logger.warn('Assertion error: %s', err.message)
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
    return new Error('Not enough balance for deposit')
  }
  return null
}

export function checkCommitment(treeProof: Proof, txProof: Proof) {
  return treeProof.inputs[2] === txProof.inputs[2]
}

export function checkTxProof(txProof: Proof) {
  const res = pool.verifyProof(txProof.proof, txProof.inputs)
  if (!res) {
    return new Error('Incorrect transfer proof')
  }
  return null
}

export async function checkNullifier(nullifier: string, nullifierSet: NullifierSet) {
  const inSet = await nullifierSet.isInSet(nullifier)
  if (inSet === 0) return null
  return new Error(`Doublespend detected in ${nullifierSet.name}`)
}

export function checkTransferIndex(contractPoolIndex: BN, transferIndex: BN) {
  if (transferIndex.lte(contractPoolIndex)) return null
  return new Error(`Incorrect transfer index`)
}

export function checkTxSpecificFields(txType: TxType, tokenAmount: BN, energyAmount: BN, txData: TxData, msgValue: BN) {
  logger.debug(
    'TOKENS %s, ENERGY %s, TX DATA %s, MSG VALUE %s',
    tokenAmount.toString(),
    energyAmount.toString(),
    JSON.stringify(txData),
    msgValue.toString()
  )
  let isValid = false
  if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT) {
    isValid = tokenAmount.gte(ZERO) && energyAmount.eq(ZERO) && msgValue.eq(ZERO)
  } else if (txType === TxType.TRANSFER) {
    isValid = tokenAmount.eq(ZERO) && energyAmount.eq(ZERO) && msgValue.eq(ZERO)
  } else if (txType === TxType.WITHDRAWAL) {
    const nativeAmount = (txData as WithdrawTxData).nativeAmount
    isValid = tokenAmount.lte(ZERO) && energyAmount.lte(ZERO)
    isValid = isValid && msgValue.eq(nativeAmount.mul(pool.denominator))
  }
  if (!isValid) {
    return new Error('Tx specific fields are incorrect')
  }
  return null
}

export function parseDelta(delta: string): Delta {
  const { poolId, index, e, v } = Helpers.parseDelta(delta)
  return {
    transferIndex: toBN(index),
    energyAmount: toBN(e),
    tokenAmount: toBN(v),
    poolId: toBN(poolId),
  }
}

export function checkNativeAmount(nativeAmount: BN | null) {
  logger.debug(`Native amount: ${nativeAmount}`)
  // Check native amount (relayer faucet)
  if (nativeAmount && nativeAmount > config.maxFaucet) {
    return new Error('Native amount too high')
  }
  return null
}

export function checkFee(fee: BN) {
  logger.debug(`Fee: ${fee}`)
  if (fee.lt(config.relayerFee)) {
    return new Error('Fee too low')
  }
  return null
}

export function checkDeadline(deadline: BN) {
  logger.debug(`Deadline: ${deadline}`)
  // Check native amount (relayer faucet)
  const currentTimestamp = new BN(Math.floor(Date.now() / 1000))
  if (deadline <= currentTimestamp) {
    return new Error(`Deadline is expired`)
  }
  return null
}

export function checkLimits(limits: Limits, amount: BN) {
  if (amount.gt(toBN(0))) {
    if (amount.gt(limits.depositCap)) {
      return new Error('Single deposit cap exceeded')
    }
    if (limits.tvl.add(amount).gte(limits.tvlCap)) {
      return new Error('Tvl cap exceeded')
    }
    if (limits.dailyUserDepositCapUsage.add(amount).gt(limits.dailyUserDepositCap)) {
      return new Error('Daily user deposit cap exceeded')
    }
    if (limits.dailyDepositCapUsage.add(amount).gt(limits.dailyDepositCap)) {
      return new Error('Daily deposit cap exceeded')
    }
  } else {
    if (limits.dailyWithdrawalCapUsage.sub(amount).gt(limits.dailyWithdrawalCap)) {
      return new Error('Daily withdrawal cap exceeded')
    }
  }
  return null
}

async function checkDepositEnoughBalance(address: string, requiredTokenAmount: BN) {
  if (requiredTokenAmount.lte(toBN(0))) {
    throw new Error('Requested balance check for token amount <= 0')
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
    return new Error('Invalid deposit signature')
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
      deadline: deadline.toString(10),
      salt: nullifier,
    }
    recoveredAddress = recoverSaltedPermit(message, sig)

    await checkAssertion(() => checkDeadline(deadline))
  } else {
    throw new Error('Unsupported txtype')
  }

  return recoveredAddress
}

export async function validateTx(
  { txType, rawMemo, txProof, depositSignature }: TxPayload,
  delta: Delta,
  nullifier: string
) {
  const buf = Buffer.from(rawMemo, 'hex')
  const txData = getTxData(buf, txType)

  await checkAssertion(() => checkNullifier(nullifier, pool.state.nullifiers))
  await checkAssertion(() => checkNullifier(nullifier, pool.optimisticState.nullifiers))
  await checkAssertion(() => checkTransferIndex(toBN(pool.optimisticState.getNextIndex()), delta.transferIndex))

  await checkAssertion(() => checkFee(txData.fee))

  if (txType === TxType.WITHDRAWAL) {
    const nativeAmount = (txData as WithdrawTxData).nativeAmount
    await checkAssertion(() => checkNativeAmount(nativeAmount))
  }

  await checkAssertion(() => checkTxProof(txProof))

  const tokenAmountWithFee = delta.tokenAmount.add(txData.fee)
  await checkAssertion(() => checkTxSpecificFields(txType, tokenAmountWithFee, delta.energyAmount, txData, toBN('0')))

  const requiredTokenAmount = tokenAmountWithFee.mul(pool.denominator)
  let userAddress = ZERO_ADDRESS
  if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT) {
    userAddress = await getRecoveredAddress(txType, nullifier, txData, requiredTokenAmount, depositSignature)
    await checkAssertion(() => checkDepositEnoughBalance(userAddress, requiredTokenAmount))
  }

  const limits = await pool.getLimitsFor(userAddress)
  await checkAssertion(() => checkLimits(limits, delta.tokenAmount))
}
