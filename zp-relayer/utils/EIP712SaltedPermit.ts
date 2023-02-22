import config from '@/configs/relayerConfig'
import { recoverTypedSignature, SignTypedDataVersion } from '@metamask/eth-sig-util'
import Web3 from 'web3'
import TokenAbi from '@/abi/token-abi.json'
import { getChainId } from './web3'
import { AbiItem } from 'web3-utils'

interface EIP712Domain {
  name: string
  version: string
  chainId: number
  verifyingContract: string
}

let domain: EIP712Domain

const PERMIT: 'Permit' = 'Permit'

const types = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  [PERMIT]: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
  ],
}

interface SaltedPermitMessage {
  owner: string
  spender: string
  value: string
  nonce: string
  deadline: string
  salt: string
}

export async function initializeDomain(web3: Web3) {
  const token = new web3.eth.Contract(TokenAbi as AbiItem[], config.tokenAddress)
  const name = await token.methods.name().call()
  const chainId = await getChainId(web3)
  domain = {
    name,
    version: '1',
    chainId,
    verifyingContract: config.tokenAddress as string,
  }
}

export function recoverSaltedPermit(message: SaltedPermitMessage, signature: string) {
  if (!domain) throw new Error('Not initialized')

  const data = {
    types,
    primaryType: PERMIT,
    domain,
    message: message as Record<string, any>,
  }
  const address = recoverTypedSignature({
    data,
    signature,
    version: SignTypedDataVersion.V4,
  })

  return address
}
