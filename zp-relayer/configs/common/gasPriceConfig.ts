import { EstimationType } from '@/services/gas-price'
import { Network } from '@/services/network'
import { z } from 'zod'
import { zBN } from './utils'

const zGasPrice = z.object({
  GAS_PRICE_ESTIMATION_TYPE: z.nativeEnum(EstimationType).default(EstimationType.Web3),
  GAS_PRICE_UPDATE_INTERVAL: z.coerce.number().default(5000),
  GAS_PRICE_SURPLUS: z.coerce.number().default(0.1),
  MIN_GAS_PRICE_BUMP_FACTOR: z.coerce.number().default(0.1),
  GAS_PRICE_FACTOR: z.coerce.number().default(1),
  GAS_PRICE_SPEED_TYPE: z.string().default('fast'),
  GAS_PRICE_FALLBACK: z.string(),
  MAX_FEE_PER_GAS_LIMIT: zBN().nullable().default(null),
})

export type GasPriceConfig<N extends Network> = N extends Network.Ethereum
  ? z.infer<typeof zGasPrice>
  : N extends Network.Tron
  ? {}
  : never

export function getGasPriceSchema<N extends Network>(network: N): GasPriceConfig<N> {
  if (network === Network.Ethereum) {
    return zGasPrice.parse(process.env) as GasPriceConfig<N>
  } else if (network === Network.Tron) {
    return {} as GasPriceConfig<N>
  } else {
    throw new Error('Unsupported network')
  }
}
