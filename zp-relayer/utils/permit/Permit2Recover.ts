import { toBN, AbiItem } from 'web3-utils'
import { CommonMessageParams, IPermitRecover, PreconditionError, TypedMessage } from './IPermitRecover'
import Permit2Abi from '@/abi/permit2.json'

export interface ITokenPermissions {
  token: string
  amount: string
}

const TokenPermissions: TypedMessage<ITokenPermissions> = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
]

export interface IPermitTransferFrom {
  permitted: ITokenPermissions
  spender: string
  nonce: string
  deadline: string
}

const PermitTransferFrom: TypedMessage<IPermitTransferFrom> = [
  { name: 'permitted', type: 'TokenPermissions' },
  { name: 'spender', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
]

export class Permit2Recover extends IPermitRecover<IPermitTransferFrom> {
  TYPES = {
    PermitTransferFrom,
    TokenPermissions,
  }

  async precondition({ nullifier, amount, owner, tokenContract }: CommonMessageParams) {
    // Make sure user approved tokens for Permit2 contract
    const approved = await tokenContract.callRetry('allowance', [owner, this.verifyingContract])
    if (toBN(approved).lt(toBN(amount))) return new PreconditionError('Permit2: Allowance is too low')

    const permit2 = this.network.contract(Permit2Abi as AbiItem[], this.verifyingContract)

    const nonce = toBN(nullifier)
    const wordPos = nonce.shrn(8)
    const bitPos = nonce.maskn(8)

    const pointer = await permit2.callRetry('nonceBitmap', [owner, wordPos])
    const isSet = toBN(pointer).testn(bitPos.toNumber())
    if (isSet) return new PreconditionError('Permit2: Nonce already used')

    return null
  }

  async buildMessage({
    deadline,
    spender,
    tokenContract,
    amount,
    nullifier,
  }: CommonMessageParams): Promise<IPermitTransferFrom> {
    const token = tokenContract.address()

    const message: IPermitTransferFrom = {
      permitted: {
        token,
        amount,
      },
      spender,
      nonce: nullifier,
      deadline,
    }
    return message
  }
}
