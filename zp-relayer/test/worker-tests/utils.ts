import type { HttpProvider } from 'web3-core'
import type BN from 'bn.js'
import Redis from 'ioredis'
import { toBN } from 'web3-utils'
import { web3 } from './web3'

export const token = new web3.eth.Contract(
  [
    {
      inputs: [
        {
          internalType: 'address',
          name: '_to',
          type: 'address',
        },
        {
          internalType: 'uint256',
          name: '_amount',
          type: 'uint256',
        },
      ],
      name: 'mint',
      outputs: [],
      type: 'function',
    },
    {
      inputs: [
        {
          internalType: 'address',
          name: 'spender',
          type: 'address',
        },
        {
          internalType: 'uint256',
          name: 'amount',
          type: 'uint256',
        },
      ],
      name: 'approve',
      outputs: [
        {
          internalType: 'bool',
          name: '',
          type: 'bool',
        },
      ],
      type: 'function',
    },
    {
      inputs: [
        {
          internalType: 'address',
          name: 'account',
          type: 'address',
        },
      ],
      name: 'balanceOf',
      outputs: [
        {
          internalType: 'uint256',
          name: '_balance',
          type: 'uint256',
        },
      ],
      type: 'function',
    },
  ],
  process.env.RELAYER_TOKEN_ADDRESS
)

const minter = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1'

function callRpcMethod(method: string, params: any[] = []) {
  return new Promise((res, rej) => {
    ;(web3.currentProvider as HttpProvider).send(
      {
        jsonrpc: '2.0',
        method,
        params,
        id: new Date().getTime(),
      },
      function (err, response) {
        if (err) rej(err)
        res(response?.result)
      }
    )
  })
}

export async function mintTokens(to: string, amount: number | BN, denominator = toBN(1000000000)) {
  if (typeof amount === 'number') amount = toBN(amount)

  await token.methods
    .mint(to, denominator.mul(amount))
    .send({ from: minter })
    .once('transactionHash', () => mineBlock())
}

export async function approveTokens(from: string, to: string, amount: number | BN, denominator = toBN(1000000000)) {
  if (typeof amount === 'number') amount = toBN(amount)

  await token.methods
    .approve(to, denominator.mul(amount))
    .send({ from })
    .once('transactionHash', () => mineBlock())
}

export function getTokenBalance(address: string) {
  return token.methods.balanceOf(address).call({ from: minter })
}

export function disableMining() {
  return callRpcMethod('evm_setAutomine', [false])
}

export function enableMining() {
  return callRpcMethod('evm_setAutomine', [true])
}

export function mineBlock() {
  return callRpcMethod('anvil_mine')
}

export function setNextBlockTimestamp(timestamp: number) {
  return callRpcMethod('evm_setNextBlockTimestamp', [timestamp])
}

export function dropTransaction(hash: string) {
  return callRpcMethod('anvil_dropTransaction', [hash])
}

export function setBalance(address: string, amount: string) {
  return callRpcMethod('anvil_setBalance', [address, amount])
}

export function evmSnapshot() {
  return callRpcMethod('evm_snapshot') as Promise<string>
}

export function evmRevert(state: string) {
  return callRpcMethod('evm_revert', [state])
}

export function newConnection() {
  return new Redis('127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  })
}
