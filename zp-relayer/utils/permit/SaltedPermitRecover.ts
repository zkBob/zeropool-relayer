import { toChecksumAddress, bytesToHex } from 'web3-utils'
import { CommonMessageParams, IPermitRecover, TypedMessage } from './IPermitRecover'
import { contractCallRetry } from '../helpers'

type SaltedPermitMessage = {
  owner: string
  spender: string
  value: string
  nonce: string
  deadline: string
  salt: string
}

const Permit: TypedMessage<SaltedPermitMessage> = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'salt', type: 'bytes32' },
]

export class SaltedPermitRecover extends IPermitRecover<SaltedPermitMessage, 'Permit'> {
  PRIMARY_TYPE: 'Permit' = 'Permit'

  TYPES = {
    Permit,
  }

  async buildMessage({
    txData,
    spender,
    tokenContract,
    amount,
    nullifier,
  }: CommonMessageParams): Promise<SaltedPermitMessage> {
    const { deadline, holder } = txData
    const owner = toChecksumAddress(bytesToHex(Array.from(holder)))
    const nonce = await contractCallRetry(tokenContract, 'nonces', [owner])

    const message: SaltedPermitMessage = {
      owner,
      spender,
      value: amount,
      nonce,
      deadline,
      salt: nullifier,
    }
    return message
  }
}
