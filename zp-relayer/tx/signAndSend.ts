import Web3 from 'web3'
import type { TransactionConfig } from 'web3-core'
import { isSameTransactionError } from '@/utils/web3Errors'

export async function signTransaction(web3: Web3, txConfig: TransactionConfig, privateKey: string) {
  const serializedTx = await web3.eth.accounts.signTransaction(txConfig, privateKey)
  return [serializedTx.transactionHash as string, serializedTx.rawTransaction as string]
}

export async function sendTransaction(web3: Web3, rawTransaction: string): Promise<void> {
  return new Promise((res, rej) =>
    // prettier-ignore
    web3.eth.sendSignedTransaction(rawTransaction)
      .once('transactionHash', () => res())
      .once('error', e => {
        // Consider 'already known' errors as a successful send
        if (isSameTransactionError(e)){
          res()
        } else {
          rej(e)
        }
      })
  )
}
