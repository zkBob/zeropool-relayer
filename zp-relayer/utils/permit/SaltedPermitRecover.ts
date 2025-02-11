import { CommonMessageParams, IPermitRecover, TypedMessage } from './IPermitRecover'

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

export class SaltedPermitRecover extends IPermitRecover<SaltedPermitMessage> {
  TYPES = {
    Permit,
  }

  async precondition() {
    return null
  }

  async buildMessage({
    owner,
    deadline,
    spender,
    tokenContract,
    amount,
    nullifier,
  }: CommonMessageParams): Promise<SaltedPermitMessage> {
    const nonce = await tokenContract.callRetry('nonces', [owner])

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
