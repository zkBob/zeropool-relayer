import { Network } from '@/services/network/types'
import { z } from 'zod'
import baseConfig from './baseConfig'
import { getGasPriceSchema } from './common/gasPriceConfig'
import { getTxManagerSchema } from './common/txManagerConfig'
import { zBooleanString } from './common/utils'

const zSchema = z.object({
  COMMITMENT_WATCHER_PORT: z.coerce.number().default(8000),
  COMMITMENT_WATCHER_NETWORK: z.nativeEnum(Network),
  COMMITMENT_WATCHER_TOKEN_ADDRESS: z.string(),
  COMMITMENT_WATCHER_PRECOMPUTE_PARAMS: zBooleanString().default('false'),
  COMMITMENT_WATCHER_TREE_UPDATE_PARAMS_PATH: z.string().default('../params/tree_params.bin'),
  COMMITMENT_WATCHER_STATE_DIR_PATH: z.string().default('./POOL_STATE'),
  COMMITMENT_WATCHER_TX_VK_PATH: z.string().default('../params/transfer_verification_key.json'),
  COMMITMENT_WATCHER_FETCH_INTERVAL: z.coerce.number().default(10000),
  COMMITMENT_WATCHER_TX_REDUNDANCY: zBooleanString().default('false'),
  COMMITMENT_WATCHER_FEE: z.coerce.number().default(50_000_000),
})

const config = zSchema.parse(process.env)

const txManager = getTxManagerSchema(config.COMMITMENT_WATCHER_NETWORK)
const gasPrice = getGasPriceSchema(config.COMMITMENT_WATCHER_NETWORK)

export default {
  ...config,
  ...baseConfig,
  txManager,
  gasPrice,
}
