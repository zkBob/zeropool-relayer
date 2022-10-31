import { signTypedData, SignTypedDataVersion } from '@metamask/eth-sig-util'
import { config } from './config'

interface EIP712Domain {
  name: string
  version: string
  chainId: number
  verifyingContract: string
}

const domain: EIP712Domain = {
  name: 'BOB',
  version: '1',
  chainId: config.chainId,
  verifyingContract: config.tokenAddress,
}

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

export function createSignature(message: SaltedPermitMessage, privateKey: string) {  
  const data = {
    types,
    primaryType: PERMIT,
    domain,
    message: message as Record<string, any>,
  }
  const signature = signTypedData({
    data,
    version: SignTypedDataVersion.V4,
    privateKey: Buffer.from(privateKey.slice(2), 'hex'),
  })

  return signature
}
