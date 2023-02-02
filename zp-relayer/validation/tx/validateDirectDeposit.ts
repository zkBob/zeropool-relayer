import type { Contract } from 'web3-eth-contract'
import type { DirectDeposit } from '@/queue/poolTxQueue'
import { contractCallRetry } from '@/utils/helpers'
import { checkAssertion, checkScreener, TxValidationError } from './common'

enum DirectDepositStatus {
  Missing = '0',
  Pending = '1',
  Completed = '2',
  Refunded = '3',
}

interface DirectDepositStruct {
  user: string
  amount: string
  deposit: string
  fee: string
  timestamp: string
  status: string
  diversifier: string
  pk: string
}

async function checkDirectDepositConsistency(dd: DirectDeposit, poolContract: Contract) {
  const ddFromContract: DirectDepositStruct = await contractCallRetry(poolContract, 'directDeposits', [dd.nonce])
  const errPrefix = `Direct deposit ${dd.nonce}`

  if (ddFromContract.status !== DirectDepositStatus.Pending) {
    throw new TxValidationError(`${errPrefix} is not pending: ${ddFromContract.status})`)
  }

  if (ddFromContract.user !== dd.fallbackUser) {
    throw new TxValidationError(
      `${errPrefix} has incorrect user: expected ${dd.fallbackUser}, actual ${ddFromContract.user})`
    )
  }

  if (ddFromContract.deposit !== dd.deposit) {
    throw new TxValidationError(
      `${errPrefix} has incorrect amount: expected ${dd.deposit}, actual ${ddFromContract.deposit})`
    )
  }
  // TODO: we can also check other fields to detect inconsistency, but these two should be sufficient

  return null
}

export async function validateDirectDeposit(dd: DirectDeposit, poolContract: Contract) {
  await checkAssertion(() => checkDirectDepositConsistency(dd, poolContract))
  await checkAssertion(() => checkScreener(dd.sender))
  await checkAssertion(() => checkScreener(dd.fallbackUser))
}
