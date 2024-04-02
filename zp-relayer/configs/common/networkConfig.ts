import { Network } from '@/lib/network'
import { z } from 'zod'
import { zBooleanString } from './utils'

const zNetwork = z.discriminatedUnion('NETWORK', [
  z.object({
    NETWORK: z.literal(Network.Ethereum),
    TX_REDUNDANCY: zBooleanString().default('false'),
  }),
  z.object({
    NETWORK: z.literal(Network.Tron),
  }),
])

export type NetworkConfig = z.infer<typeof zNetwork>

export function getNetworkConfig(): NetworkConfig {
  return zNetwork.parse(process.env)
}
