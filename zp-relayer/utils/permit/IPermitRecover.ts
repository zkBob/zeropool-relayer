import type Web3 from 'web3'
import type { Contract } from 'web3-eth-contract'
import type { TxData, TxType } from 'zp-memo-parser'
import { ethers } from 'ethers'

export interface CommonMessageParams {
  txData: TxData<TxType.PERMITTABLE_DEPOSIT>
  spender: string
  tokenContract: Contract
  amount: string
  nullifier: string
}

export type TypedMessage<Message extends Record<string, any>> = { name: keyof Message & string; type: string }[]

export abstract class IPermitRecover<Message extends Record<string, any>, PrimaryType extends string> {
  DOMAIN_SEPARATOR: string | null = null
  abstract TYPES: { [key in PrimaryType]: TypedMessage<Message> }
  abstract PRIMARY_TYPE: PrimaryType

  async initializeDomain(web3: Web3, verifyingContract: string) {
    const contract = new web3.eth.Contract(
      [
        {
          inputs: [],
          stateMutability: 'view',
          type: 'function',
          name: 'DOMAIN_SEPARATOR',
          outputs: [
            {
              internalType: 'bytes32',
              name: '',
              type: 'bytes32',
            },
          ],
        },
      ],
      verifyingContract
    )
    this.DOMAIN_SEPARATOR = await contract.methods.DOMAIN_SEPARATOR().call()
  }

  abstract buildMessage(params: CommonMessageParams): Promise<Message>

  async recoverPermitSignature(messageParams: CommonMessageParams, signature: string) {
    if (!this.DOMAIN_SEPARATOR) throw new Error('Domain not initialized')

    const message = await this.buildMessage(messageParams)

    const data = ethers.concat([
      '0x1901',
      this.DOMAIN_SEPARATOR,
      ethers.TypedDataEncoder.from(this.TYPES).hash(message),
    ])
    const signedHash = ethers.keccak256(data)
    const address = ethers.recoverAddress(signedHash, signature)
    return address
  }
}
