import { z } from 'zod'
import { getBaseConfig } from './baseConfig'
import { getNetworkConfig } from './common/networkConfig'
import { zBooleanString } from './common/utils'

const schema = z.object({
  INDEXER_PORT: z.coerce.number().default(8000),
  INDEXER_REQUEST_LOG_PATH: z.string().default('./indexer.log'),
  INDEXER_EXPRESS_TRUST_PROXY: zBooleanString().default('false'),
  INDEXER_STATE_DIR_PATH: z.string().default('./INDEXER_STATE'),
  INDEXER_TX_VK_PATH: z.string().default('../params/transfer_verification_key.json'),
  INDEXER_TOKEN_ADDRESS: z.string(),
  INDEXER_BLOCK_CONFIRMATIONS: z.coerce.number().default(1),
})

const config = schema.parse(process.env)

export default {
  ...config,
  base: getBaseConfig(),
  network: getNetworkConfig(),
}
