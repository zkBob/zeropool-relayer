import Web3 from 'web3'
import TokenAbi from '@/abi/token-abi.json'
import { AbiItem, toChecksumAddress, bytesToHex } from 'web3-utils'
import { CommonMessageParams, EIP712Domain, IPermitRecover, TypedMessage } from './IPermitRecover'
import { contractCallRetry } from '../helpers'

type SaltedPermitMessage = {
  owner: string
  spender: string
  value: string
  nonce: string
  deadline: string
  salt: string
}

const Domain: TypedMessage<EIP712Domain> = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]

const Permit: TypedMessage<SaltedPermitMessage> = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'salt', type: 'bytes32' },
]

export class SaltedPermitRecover extends IPermitRecover<SaltedPermitMessage, 'Permit'> {
  PRIMARY_TYPE: 'Permit' = 'Permit'

  TYPES = {
    EIP712Domain: Domain,
    Permit,
  }

  async buildMessage({
    txData,
    spender,
    tokenContract,
    amount,
    nullifier,
  }: CommonMessageParams): Promise<SaltedPermitMessage> {
    const { deadline, holder } = txData
    const owner = toChecksumAddress(bytesToHex(Array.from(holder)))
    const nonce = await contractCallRetry(tokenContract, 'nonces', [owner])

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

  async initializeDomain(web3: Web3, verifyingContract: string) {
    const token = new web3.eth.Contract(TokenAbi as AbiItem[], verifyingContract)
    const name = await token.methods.name().call()
    const chainId = await web3.eth.getChainId()
    this.DOMAIN_SEPARATOR = {
      name,
      version: '1',
      chainId,
      verifyingContract,
    }
  }
}
