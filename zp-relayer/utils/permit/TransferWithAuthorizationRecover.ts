import { toBN, numberToHex, AbiItem } from 'web3-utils'
import { CommonMessageParams, IPermitRecover, PreconditionError, TypedMessage } from './IPermitRecover'
import { contractCallRetry } from '../helpers'
import Erc3009Abi from '@/abi/erc3009.json'

export interface ITransferWithAuthorization {
  from: string
  to: string
  value: string
  validAfter: string
  validBefore: string
  nonce: string
}

const TransferWithAuthorization: TypedMessage<ITransferWithAuthorization> = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
]

export class TransferWithAuthorizationRecover extends IPermitRecover<ITransferWithAuthorization> {
  TYPES = {
    TransferWithAuthorization,
  }

  async precondition({ owner, tokenContract, nullifier }: CommonMessageParams) {
    const token = new this.web3.eth.Contract(Erc3009Abi as AbiItem[], tokenContract.options.address)
    const isUsed = await contractCallRetry(token, 'authorizationState', [owner, numberToHex(nullifier)])
    if (!toBN(isUsed).isZero()) {
      return new PreconditionError('TransferWithAuthorization: authorization is used or canceled')
    }
    return null
  }

  async buildMessage({
    owner,
    deadline,
    spender,
    amount,
    nullifier,
  }: CommonMessageParams): Promise<ITransferWithAuthorization> {
    const message: ITransferWithAuthorization = {
      from: owner,
      to: spender,
      value: amount,
      validAfter: '0',
      validBefore: deadline,
      nonce: nullifier,
    }
    return message
  }
}
