import type Web3 from 'web3'
import type { HttpProvider } from 'web3-core'
import { web3 } from './web3'
import { toBN } from 'web3-utils'
import TokenAbi from './abi/token-abi.json'

export const token = new web3.eth.Contract(TokenAbi as any, '0xe78A0F7E598Cc8b0Bb87894B0F60dD2a88d6a8Ab')
const denominator = toBN(1000000000)
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
      function (err, result) {
        if (err) rej(err)
        res(result)
      }
    )
  })
}

export async function mintTokens(to: string, amount: number) {
  await token.methods.mint(to, denominator.muln(amount))
    .send({ from: minter })
    .once('transactionHash', () => mineBlock())
}

export async function disableMining() {
  await callRpcMethod('evm_setAutomine', [false])
}

export async function enableMining() {
  await callRpcMethod('evm_setAutomine', [true])
}


export function mineBlock() {
  return callRpcMethod('anvil_mine')
}
