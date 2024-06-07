import { z } from 'zod'
import { getBaseConfig } from './baseConfig'
import { getNetworkConfig } from './common/networkConfig'

const zSchema = z.object({
  RELAYER_TOKEN_ADDRESS: z.string(),
  WATCHER_BLOCK_CONFIRMATIONS: z.coerce.number().default(1),
  WATCHER_EVENT_POLLING_INTERVAL: z.coerce.number().default(600000),
  DIRECT_DEPOSIT_BATCH_SIZE: z.coerce.number().default(16),
  DIRECT_DEPOSIT_BATCH_TTL: z.coerce.number().default(3600000),
})

const network = getNetworkConfig()

export default {
  ...zSchema.parse(process.env),
  network,
  base: getBaseConfig(),
}
