import { toChecksumAddress, bytesToHex } from 'web3-utils'
import { CommonMessageParams, IPermitRecover, TypedMessage } from './IPermitRecover'

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

export class TransferWithAuthorizationRecover extends IPermitRecover<
  ITransferWithAuthorization,
  'TransferWithAuthorization'
> {
  PRIMARY_TYPE: 'TransferWithAuthorization' = 'TransferWithAuthorization'

  TYPES = {
    TransferWithAuthorization,
  }

  async buildMessage({ txData, spender, amount, nullifier }: CommonMessageParams): Promise<ITransferWithAuthorization> {
    const { holder, deadline } = txData
    const from = toChecksumAddress(bytesToHex(Array.from(holder)))

    const message: ITransferWithAuthorization = {
      from,
      to: spender,
      value: amount,
      validAfter: '0',
      validBefore: deadline,
      nonce: nullifier,
    }
    return message
  }
}
