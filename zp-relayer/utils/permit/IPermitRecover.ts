import { NetworkBackend } from '@/services/network/NetworkBackend'
import { Network, NetworkContract } from '@/services/network/types'
import { ethers } from 'ethers'

export class PreconditionError extends Error {
  name = 'PreconditionError'
  constructor(message: string) {
    super(message)
  }
}

export interface CommonMessageParams {
  owner: string
  deadline: string
  spender: string
  tokenContract: NetworkContract<Network>
  amount: string
  nullifier: string
}

export type TypedMessage<Message extends Record<string, any>> = { name: keyof Message & string; type: string }[]

export abstract class IPermitRecover<Message extends Record<string, any>> {
  DOMAIN_SEPARATOR: string | null = null
  abstract TYPES: { [key: string]: TypedMessage<Record<string, any>> }

  constructor(protected network: NetworkBackend<Network>, protected verifyingContract: string) {}

  async initializeDomain() {
    const contract = this.network.contract(
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
      this.verifyingContract
    )
    this.DOMAIN_SEPARATOR = await contract.callRetry('DOMAIN_SEPARATOR')
  }

  abstract precondition(params: CommonMessageParams): Promise<null | PreconditionError>

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
