import { z } from 'zod'
import { getBaseConfig } from './baseConfig'
import { getGasPriceConfig } from './common/gasPriceConfig'
import { getNetworkConfig } from './common/networkConfig'
import { getTxManagerConfig } from './common/txManagerConfig'
import { zBN, zBooleanString } from './common/utils'

const zSchema = z.object({
  COMMITMENT_WATCHER_PORT: z.coerce.number().default(8000),
  COMMITMENT_WATCHER_TOKEN_ADDRESS: z.string(),
  COMMITMENT_WATCHER_PRECOMPUTE_PARAMS: zBooleanString().default('false'),
  COMMITMENT_WATCHER_TREE_UPDATE_PARAMS_PATH: z.string().default('../params/tree_params.bin'),
  COMMITMENT_WATCHER_DIRECT_DEPOSIT_PARAMS_PATH: z.string().default('../params/delegated_deposit_params.bin'),
  COMMITMENT_WATCHER_STATE_DIR_PATH: z.string().default('./POOL_STATE'),
  COMMITMENT_WATCHER_TX_VK_PATH: z.string().default('../params/transfer_verification_key.json'),
  COMMITMENT_WATCHER_FETCH_INTERVAL: z.coerce.number().default(10000),
  COMMITMENT_WATCHER_FEE: zBN().default("100_000_000"),
})

const network = getNetworkConfig()

export default {
  ...zSchema.parse(process.env),
  network,
  base: getBaseConfig(),
  txManager: getTxManagerConfig(network.NETWORK),
  gasPrice: getGasPriceConfig(network.NETWORK),
}
