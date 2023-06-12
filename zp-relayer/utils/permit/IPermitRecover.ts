import type Web3 from 'web3'
import type { Contract } from 'web3-eth-contract'
import type { TxData, TxType } from 'zp-memo-parser'
import { recoverTypedSignature, SignTypedDataVersion } from '@metamask/eth-sig-util'

export interface EIP712Domain {
  name?: string
  version?: string
  chainId?: number
  verifyingContract?: string
}

export interface CommonMessageParams {
  txData: TxData<TxType.PERMITTABLE_DEPOSIT>
  spender: string
  tokenContract: Contract
  amount: string
  nullifier: string
}

export type TypedMessage<Message extends Record<string, any>> = { name: keyof Message; type: string }[]

export abstract class IPermitRecover<Message extends Record<string, any>, PrimaryType extends string> {
  DOMAIN_SEPARATOR: EIP712Domain | null = null
  abstract TYPES: { EIP712Domain: TypedMessage<EIP712Domain> } & { [key in PrimaryType]: TypedMessage<Message> }
  abstract PRIMARY_TYPE: PrimaryType

  abstract initializeDomain(web3: Web3, verifyingContract: string): Promise<void>

  abstract buildMessage(params: CommonMessageParams): Promise<Message>

  async recoverPermitSignature(messageParams: CommonMessageParams, signature: string) {
    if (!this.DOMAIN_SEPARATOR) throw new Error('Not initialized')

    const message = await this.buildMessage(messageParams)
    const data = {
      types: this.TYPES,
      primaryType: this.PRIMARY_TYPE,
      domain: this.DOMAIN_SEPARATOR,
      message,
    }
    const address = recoverTypedSignature({
      data,
      signature,
      version: SignTypedDataVersion.V4,
    })

    return address
  }
}
