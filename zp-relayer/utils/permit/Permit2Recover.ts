import { toBN } from 'web3-utils'
import { CommonMessageParams, IPermitRecover, PreconditionError, TypedMessage } from './IPermitRecover'
import { contractCallRetry } from '../helpers'

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

export class Permit2Recover extends IPermitRecover<IPermitTransferFrom, 'PermitTransferFrom'> {
  PRIMARY_TYPE: 'PermitTransferFrom' = 'PermitTransferFrom'

  TYPES = {
    PermitTransferFrom,
    TokenPermissions,
  }

  async precondition({ nullifier, amount, owner, tokenContract }: CommonMessageParams) {
    // Make sure user approved tokens for Permit2 contract
    const approved = await contractCallRetry(tokenContract, 'allowance', [owner, this.verifyingContract])
    if (toBN(approved).lt(toBN(amount))) return new PreconditionError('Permit2: Allowance is too low')

    const permit2 = new this.web3.eth.Contract(
      [
        {
          inputs: [
            { internalType: 'address', name: '', type: 'address' },
            { internalType: 'uint256', name: '', type: 'uint256' },
          ],
          name: 'nonceBitmap',
          outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
          stateMutability: 'view',
          type: 'function',
        },
      ],
      this.verifyingContract
    )

    const nonce = toBN(nullifier)
    const wordPos = nonce.shrn(8)
    const bitPos = nonce.maskn(8)

    const pointer = await contractCallRetry(permit2, 'nonceBitmap', [owner, wordPos])
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
    const token = tokenContract.options.address

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
