import { logger } from '@/lib/appLogger'
import type { NetworkBackend } from '@/lib/network/NetworkBackend'
import type { Network } from '@/lib/network/types'
import { Limits } from '@/pool/types'
import type { NullifierSet } from '@/state/nullifierSet'
import type { PoolState } from '@/state/PoolState'
import { HEADER_TRACE_ID, MESSAGE_PREFIX_COMMON_V1, MESSAGE_PREFIX_COMMON_V2, ZERO_ADDRESS } from '@/utils/constants'
import {
  fetchJson,
  numToHex,
  truncateMemoTxPrefix,
  truncateMemoTxPrefixProverV2,
  unpackSignature,
} from '@/utils/helpers'
import type { PermitRecover } from '@/utils/permit/types'
import BN from 'bn.js'
import { Proof, SnarkProof } from 'libzkbob-rs-node'
import { bytesToHex, toBN, toChecksumAddress } from 'web3-utils'
import { TxData, TxType } from 'zp-memo-parser'

export class TxValidationError extends Error {
  name = 'TxValidationError'
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

export function checkCondition(condition: boolean, message: string = '') {
  if (!condition) {
    throw new TxValidationError(message)
  }
}

export function checkSize(data: string, size: number) {
  return data.length === size
}

export async function checkScreener(address: string, screenerUrl: string, screenerToken: string, traceId?: string) {
  const ACC_VALIDATION_FAILED = 'Internal account validation failed'

  const headers: Record<string, string> = {
    'Content-type': 'application/json',
    'Authorization': `Bearer ${screenerToken}`,
  }

  if (traceId) headers[HEADER_TRACE_ID] = traceId

  try {
    const rawResponse = await fetch(screenerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ address }),
    })
    const response = await rawResponse.json()
    if (response.result === true) {
      return new TxValidationError(ACC_VALIDATION_FAILED)
    }
  } catch (e) {
    logger.error('Request to screener failed', { error: (e as Error).message })
    return new TxValidationError(ACC_VALIDATION_FAILED)
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
  return new TxValidationError(`Doublespend detected in ${nullifierSet.name}: ${nullifier}`)
}

export async function checkNullifierContract(nullifier: string, network: NetworkBackend<Network>) {
  const isSet = await network.pool.callRetry('nullifiers', [nullifier])
  if (!toBN(isSet).eqn(0)) {
    return new TxValidationError(`Doublespend detected in contract ${nullifier}`)
  }
  return null
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

export async function checkDepositEnoughBalance(
  network: NetworkBackend<Network>,
  address: string,
  requiredTokenAmount: BN
) {
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

export async function getRecoveredAddress<T extends TxType, N extends Network>(
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

export function checkRoot(proofIndex: BN, proofRoot: string, state: PoolState) {
  const index = proofIndex.toNumber()

  const stateRoot = state.getMerkleRootAt(index)
  if (stateRoot !== proofRoot) {
    return new TxValidationError(`Incorrect root at index ${index}: given ${proofRoot}, expected ${stateRoot}`)
  }

  return null
}

export async function checkRootIndexer(proofIndex: BN, proofRoot: string, indexerUrl: string) {
  const index = proofIndex.toNumber()
  const { root } = await fetchJson(indexerUrl, '/root', [['index', index.toString()]])

  if (root !== proofRoot) {
    return new TxValidationError(`Incorrect root at index ${index}: given ${proofRoot}, expected ${root}`)
  }

  return null
}

export function checkPoolId(deltaPoolId: BN, contractPoolId: BN) {
  if (deltaPoolId.eq(contractPoolId)) {
    return null
  }
  return new TxValidationError(`Incorrect poolId: given ${deltaPoolId}, expected ${contractPoolId}`)
}

export function checkMemoPrefix(memo: string, txType: TxType) {
  const numItemsSuffix = truncateMemoTxPrefix(memo, txType).substring(4, 8)
  if (numItemsSuffix === MESSAGE_PREFIX_COMMON_V1) {
    return null
  }
  return new TxValidationError(`Memo prefix is incorrect: ${numItemsSuffix}`)
}

export function checkMemoPrefixProverV2(memo: string, txType: TxType) {
  const numItemsSuffix = truncateMemoTxPrefixProverV2(memo, txType).substring(4, 8)
  if (numItemsSuffix === MESSAGE_PREFIX_COMMON_V2) {
    return null
  }
  return new TxValidationError(`Memo prefix is incorrect: ${numItemsSuffix}`)
}

export function checkAddressEq(address1: string, address2: string) {
  if (address1.toLowerCase() === address2.toLowerCase()) {
    return null
  }
  return new TxValidationError(`Addresses are not equal: ${address1} != ${address2}`)
}
