import { z } from 'zod'
import { zBooleanString, zNullishString } from './common/utils'

const schema = z.object({
  COMMON_POOL_ADDRESS: z.string(),
  COMMON_START_BLOCK: z.coerce.number().default(0),
  COMMON_INDEXER_URL: z.string().optional(),
  COMMON_REDIS_URL: z.string(),
  COMMON_RPC_URL: z.string().transform(us => us.split(' ').filter(url => url.length > 0)),
  COMMON_REQUIRE_RPC_HTTPS: zBooleanString().default('false'),
  COMMON_RPC_SYNC_STATE_CHECK_INTERVAL: z.coerce.number().default(0),
  COMMON_RPC_REQUEST_TIMEOUT: z.coerce.number().default(1000),
  COMMON_JSONRPC_ERROR_CODES: z
    .string()
    .transform(s =>
      s
        .split(' ')
        .filter(s => s.length > 0)
        .map(s => parseInt(s, 10))
    )
    .default('-32603 -32002 -32005'),
  COMMON_EVENTS_PROCESSING_BATCH_SIZE: z.coerce.number().default(10000),
  COMMON_SCREENER_URL: zNullishString(),
  COMMON_SCREENER_TOKEN: zNullishString(),
})

export type BaseConfig = z.infer<typeof schema>

export function getBaseConfig(): BaseConfig {
  return schema.parse(process.env)
}
