import { z } from 'zod'
import { getBaseConfig } from './baseConfig'

const schema = z.object({
  INDEXER_PORT: z.coerce.number().default(8000),
  WATCHER_BLOCK_CONFIRMATIONS: z.coerce.number().default(1),
  WATCHER_EVENT_POLLING_INTERVAL: z.coerce.number().default(600000),
  DIRECT_DEPOSIT_BATCH_SIZE: z.coerce.number().default(16),
  DIRECT_DEPOSIT_BATCH_TTL: z.coerce.number().default(3600000),
})

const config = schema.parse(process.env)

export default {
  ...config,
  base: getBaseConfig(),
}
