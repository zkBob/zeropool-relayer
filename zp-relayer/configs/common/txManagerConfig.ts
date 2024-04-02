import { Network } from '@/lib/network/types'
import Web3 from 'web3'
import { z } from 'zod'
import { TxType } from 'zp-memo-parser'
import { zBN } from './utils'

const zBaseConfig = z
  .object({
    TX_PRIVATE_KEY: z.string(),
  })
  .transform(o => ({
    TX_ADDRESS: new Web3().eth.accounts.privateKeyToAccount(o.TX_PRIVATE_KEY).address,
    TX_PRIVATE_KEY: o.TX_PRIVATE_KEY,
  }))

const zTxGas = z
  .object({
    BASE_TX_GAS_DEPOSIT: zBN().default('650000'),
    BASE_TX_GAS_PERMITTABLE_DEPOSIT: zBN().default('650000'),
    BASE_TX_GAS_TRANSFER: zBN().default('650000'),
    BASE_TX_GAS_WITHDRAWAL: zBN().default('650000'),
    BASE_TX_GAS_NATIVE_CONVERT: zBN().default('200000'),
  })
  .transform(o => ({
    baseTxGas: {
      [TxType.DEPOSIT]: o.BASE_TX_GAS_DEPOSIT,
      [TxType.PERMITTABLE_DEPOSIT]: o.BASE_TX_GAS_PERMITTABLE_DEPOSIT,
      [TxType.TRANSFER]: o.BASE_TX_GAS_TRANSFER,
      [TxType.WITHDRAWAL]: o.BASE_TX_GAS_WITHDRAWAL,
      RELAYER_BASE_TX_GAS_NATIVE_CONVERT: o.BASE_TX_GAS_NATIVE_CONVERT,
    },
  }))

const zEvmConfig = z
  .object({
    TX_MIN_GAS_PRICE_BUMP_FACTOR: z.coerce.number().default(0.1),
    TX_GAS_PRICE_SURPLUS: z.coerce.number().default(0.1),
    TX_MAX_FEE_PER_GAS_LIMIT: zBN().nullable().default(null),
  })
  .and(zTxGas)
  .and(zBaseConfig)

const zTronConfig = z.object({}).and(zBaseConfig)

export type TxManagerConfig<N extends Network> = N extends Network.Ethereum
  ? z.infer<typeof zEvmConfig>
  : N extends Network.Tron
  ? z.infer<typeof zTronConfig>
  : never

export function getTxManagerConfig<N extends Network>(network: N): TxManagerConfig<N> {
  if (network === Network.Ethereum) {
    return zEvmConfig.parse(process.env) as TxManagerConfig<N>
  } else if (network === Network.Tron) {
    return zTronConfig.parse(process.env) as TxManagerConfig<N>
  } else {
    throw new Error('Unsupported network')
  }
}
