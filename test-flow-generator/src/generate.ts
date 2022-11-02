import init, { TransactionData, UserAccount, UserState } from 'libzkbob-rs-wasm-web'
import { toChecksumAddress } from 'web3-utils'
import type { Flow, FlowOutput } from './types'
import { ethAddrToBuf, packSignature, toTwosComplementHex } from './helpers'
import { createSignature } from './EIP712'
import { config } from './config'

const TEN_YEARS = 315569520
const denominator = 1000000000n

export async function newAccount() {
  const sk = Array.from({ length: 10 }, () => Math.floor(Math.random() * 100))
  const stateId = sk.toString()
  const state = await UserState.init(stateId)
  const zkAccount = UserAccount.fromSeed(Uint8Array.from(sk), state)
  return zkAccount
}

async function createDepositPermittable(
  acc: UserAccount,
  amount: string,
  from: string
): Promise<[TransactionData, string]> {
  const deadline = String(Math.floor(Date.now() / 1000) + TEN_YEARS)
  const tx = await acc.createDepositPermittable({
    fee: '0',
    amount,
    deadline,
    holder: ethAddrToBuf(from),
  })

  return [tx, deadline]
}

async function createTransfer(acc: UserAccount, amount: string, zkAddress: string) {
  const tx = await acc.createTransfer({
    fee: '0',
    outputs: [{ amount, to: zkAddress }],
  })

  return tx
}

async function createWithdraw(acc: UserAccount, amount: string, to: string) {
  const tx = await acc.createWithdraw({
    fee: '0',
    amount,
    to: ethAddrToBuf(to),
    native_amount: '0',
    energy_amount: '0',
  })

  return tx
}

async function createFlow(acc: UserAccount, { accounts, flow }: Flow): Promise<FlowOutput> {
  const flowOutput: FlowOutput = []
  const nonces: Record<string, number> = {}
  for (let [i, item] of flow.entries()) {
    let tx
    let depositSignature = null
    if ('from' in item) {
      const [depositTx, deadline] = await createDepositPermittable(acc, item.amount, item.from)
      const nonce = nonces[item.from] || 0
      const salt = '0x' + toTwosComplementHex(BigInt(depositTx.public.nullifier), 32)
      depositSignature = packSignature(
        createSignature(
          {
            owner: toChecksumAddress(item.from),
            spender: toChecksumAddress(config.poolAddress),
            value: (BigInt(parseInt(item.amount)) * denominator).toString(10),
            nonce: nonce.toString(),
            deadline,
            salt,
          },
          accounts[item.from]
        )
      )
      nonces[item.from] = nonce + 1
      tx = depositTx
    } else if ('to' in item) {
      tx = await createWithdraw(acc, item.amount, item.to)
    } else if ('zkAddress' in item) {
      tx = await createTransfer(acc, item.amount, item.zkAddress)
    } else {
      throw Error('Unknown flow item')
    }
    acc.addAccount(BigInt(i) * 128n, tx.out_hashes, tx.secret.tx.output[0], [])

    flowOutput.push({
      txTypeData: item,
      depositSignature,
      transactionData: tx,
    })
  }
  return flowOutput
}

Object.assign(global, {
  init,
  newAccount,
  createFlow,
})
