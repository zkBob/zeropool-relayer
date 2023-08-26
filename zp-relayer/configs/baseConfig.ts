import { z } from 'zod'

export const zBooleanString = () => z.enum(['true', 'false']).transform(value => value === 'true')
export const zNullishString = () =>
  z
    .string()
    .optional()
    .transform(x => x ?? null)

const schema = z.object({
  COMMON_POOL_ADDRESS: z.string(),
  COMMON_START_BLOCK: z.coerce.number().default(0),
  COMMON_COLORIZE_LOGS: zBooleanString().default('false'),
  COMMON_LOG_LEVEL: z.string().default('debug'),
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

const config = schema.parse(process.env)

export default config
