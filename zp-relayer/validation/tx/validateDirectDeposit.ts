import type { Contract } from 'web3-eth-contract'
import type { DirectDeposit } from '@/queue/poolTxQueue'
import { contractCallRetry } from '@/utils/helpers'
import { checkAssertion, checkScreener } from "./common"

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
  // const ddFromContract: DirectDepositStruct = await contractCallRetry(poolContract, 'directDeposits', [dd.nonce])
  // if (ddFromContract.status !== DirectDepositStatus.Pending ||
  //   ddFromContract.user !== dd.sender ||
  // ) {
    return null
  // }
  // throw new Error(`Direct deposit with nonce ${dd.nonce} is not pending`)
}

export async function validateDirectDeposit(dd: DirectDeposit, poolContract: Contract) {
  await checkAssertion(() => checkDirectDepositConsistency(dd, poolContract))
  await checkAssertion(() => checkScreener(dd.sender))
  await checkAssertion(() => checkScreener(dd.fallbackUser))
}
