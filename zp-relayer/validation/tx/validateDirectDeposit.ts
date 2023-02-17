import { toBN } from 'web3-utils'
import type { Contract } from 'web3-eth-contract'
import type { DirectDeposit } from '@/queue/poolTxQueue'
import { contractCallRetry } from '@/utils/helpers'
import { checkAssertion, checkScreener, TxValidationError } from './common'

const SNARK_SCALAR_FIELD = toBN('21888242871839275222246405745257275088548364400416034343698204186575808495617')

enum DirectDepositStatus {
  Missing = '0',
  Pending = '1',
  Completed = '2',
  Refunded = '3',
}

interface DirectDepositStruct {
  fallbackReceiver: string
  sent: string
  deposit: string
  fee: string
  timestamp: string
  status: string
  diversifier: string
  pk: string
}

function checkDirectDepositPK(pk: string) {
  if (toBN(pk).lt(SNARK_SCALAR_FIELD)) {
    return null
  }
  throw new TxValidationError(`Direct deposit has invalid pk: ${pk}`)
}

async function checkDirectDepositConsistency(dd: DirectDeposit, directDepositContract: Contract) {
  const ddFromContract: DirectDepositStruct = await contractCallRetry(directDepositContract, 'getDirectDeposit', [dd.nonce])
  const errPrefix = `Direct deposit ${dd.nonce}`

  if (ddFromContract.status !== DirectDepositStatus.Pending) {
    throw new TxValidationError(`${errPrefix} is not pending: ${ddFromContract.status})`)
  }

  if (ddFromContract.fallbackReceiver !== dd.fallbackUser) {
    throw new TxValidationError(
      `${errPrefix} has incorrect user: expected ${dd.fallbackUser}, actual ${ddFromContract.fallbackReceiver})`
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

export async function validateDirectDeposit(dd: DirectDeposit, directDepositContract: Contract) {
  await checkAssertion(() => checkDirectDepositPK(dd.zkAddress.pk))
  await checkAssertion(() => checkDirectDepositConsistency(dd, directDepositContract))
  await checkAssertion(() => checkScreener(dd.sender))
  await checkAssertion(() => checkScreener(dd.fallbackUser))
}
