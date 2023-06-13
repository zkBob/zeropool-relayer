import { CommonMessageParams, IPermitRecover, TypedMessage } from './IPermitRecover'

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

  async buildMessage({
    txData,
    spender,
    tokenContract,
    amount,
    nullifier,
  }: CommonMessageParams): Promise<IPermitTransferFrom> {
    const { deadline } = txData
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
