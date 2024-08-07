import { Network, NetworkContract } from '@/lib/network'
import type { DirectDeposit } from '@/queue/poolTxQueue'
import { Helpers } from 'libzkbob-rs-node'
import { toBN } from 'web3-utils'
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
  const bnPk = toBN(pk)
  if (bnPk.gte(SNARK_SCALAR_FIELD)) {
    throw new TxValidationError(`Direct deposit pk is out of snark scalar field: ${pk}`)
  }
  if (!Helpers.isInPrimeSubgroup(Helpers.strToNum(bnPk.toString(10)))) {
    throw new TxValidationError(`Direct deposit pk is not in prime subgroup: ${pk}`)
  }
  return null
}

async function checkDirectDepositConsistency(dd: DirectDeposit, directDepositContract: NetworkContract<Network>) {
  const ddFromContract: DirectDepositStruct = await directDepositContract.callRetry('getDirectDeposit', [dd.nonce])
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

export interface TxScreener {
  url: string
  token: string
}

export async function validateDirectDeposit(
  dd: DirectDeposit,
  directDepositContract: NetworkContract<Network>,
  screener?: TxScreener
) {
  await checkAssertion(() => checkDirectDepositPK(dd.zkAddress.pk))
  await checkAssertion(() => checkDirectDepositConsistency(dd, directDepositContract))

  if (screener) {
    await checkAssertion(() => checkScreener(dd.sender, screener.url, screener.token))
    await checkAssertion(() => checkScreener(dd.fallbackUser, screener.url, screener.token))
  }
}
