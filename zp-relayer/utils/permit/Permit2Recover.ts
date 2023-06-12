import type Web3 from 'web3'
import { CommonMessageParams, EIP712Domain, IPermitRecover, TypedMessage } from './IPermitRecover'

const Domain: TypedMessage<EIP712Domain> = [
  { name: 'name', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]

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
    EIP712Domain: Domain,
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

  async initializeDomain(web3: Web3, verifyingContract: string) {
    const chainId = await web3.eth.getChainId()
    this.DOMAIN_SEPARATOR = {
      name: 'Permit2',
      chainId,
      verifyingContract,
    }
  }
}
