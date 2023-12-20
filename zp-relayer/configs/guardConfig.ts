import { z } from 'zod'
import { Network } from '@/services/network/types'

export const zBooleanString = () => z.enum(['true', 'false']).transform(value => value === 'true')

const schema = z.object({
  GUARD_PORT: z.coerce.number(),
  GUARD_NETWORK: z.nativeEnum(Network),
  COMMON_RPC_URL: z.string().transform(us => us.split(' ').filter(url => url.length > 0)),
  GUARD_ADDRESS_PRIVATE_KEY: z.string(),
  GUARD_TOKEN_ADDRESS: z.string(),
  COMMON_REQUIRE_RPC_HTTPS: zBooleanString().default('false'),
  COMMON_POOL_ADDRESS: z.string(),
  GUARD_TX_VK_PATH: z.string().default('../params/transfer_verification_key.json'),
  GUARD_TREE_VK_PATH: z.string().default('../params/tree_verification_key.json'),
})

const config = schema.parse(process.env)

export default {
  ...config,
}
