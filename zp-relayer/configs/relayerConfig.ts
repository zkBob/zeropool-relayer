import { logger } from '@/lib/appLogger'
import { FeeManagerType } from '@/lib/fee'
import { ProverType } from '@/prover'
import { countryCodes } from '@/utils/countryCodes'
import { PermitType } from '@/utils/permit/types'
import { z } from 'zod'
import { TxType } from 'zp-memo-parser'
import { getBaseConfig } from './baseConfig'
import { getGasPriceConfig } from './common/gasPriceConfig'
import { getNetworkConfig } from './common/networkConfig'
import { getPriceFeedConfig } from './common/priceFeedConfig'
import { getTxManagerConfig } from './common/txManagerConfig'
import { zBN, zBooleanString, zNullishString } from './common/utils'

const defaultHeaderBlacklist =
  'accept accept-language accept-encoding connection content-length content-type postman-token referer upgrade-insecure-requests'

const zBaseTxGas = z
  .object({
    RELAYER_BASE_TX_GAS_DEPOSIT: zBN().default('650000'),
    RELAYER_BASE_TX_GAS_PERMITTABLE_DEPOSIT: zBN().default('650000'),
    RELAYER_BASE_TX_GAS_TRANSFER: zBN().default('650000'),
    RELAYER_BASE_TX_GAS_WITHDRAWAL: zBN().default('650000'),
    RELAYER_BASE_TX_GAS_NATIVE_CONVERT: zBN().default('200000'),
  })
  .transform(o => ({
    baseTxGas: {
      [TxType.DEPOSIT]: o.RELAYER_BASE_TX_GAS_DEPOSIT,
      [TxType.PERMITTABLE_DEPOSIT]: o.RELAYER_BASE_TX_GAS_PERMITTABLE_DEPOSIT,
      [TxType.TRANSFER]: o.RELAYER_BASE_TX_GAS_TRANSFER,
      [TxType.WITHDRAWAL]: o.RELAYER_BASE_TX_GAS_WITHDRAWAL,
      RELAYER_BASE_TX_GAS_NATIVE_CONVERT: o.RELAYER_BASE_TX_GAS_NATIVE_CONVERT,
    },
  }))

const zFeeManager = z
  .object({
    RELAYER_FEE_MARGIN_FACTOR: zBN().default('100'),
    RELAYER_FEE_SCALING_FACTOR: zBN().default('100'),
    RELAYER_FEE_MANAGER_UPDATE_INTERVAL: z.coerce.number().default(10000),
  })
  .and(
    z.discriminatedUnion('RELAYER_FEE_MANAGER_TYPE', [
      z.object({ RELAYER_FEE_MANAGER_TYPE: z.literal(FeeManagerType.Optimism) }),
      z.object({ RELAYER_FEE_MANAGER_TYPE: z.literal(FeeManagerType.Dynamic) }),
      z.object({ RELAYER_FEE_MANAGER_TYPE: z.literal(FeeManagerType.Static), RELAYER_FEE: zBN() }),
    ])
  )

const zSchema = z
  .object({
    RELAYER_REF: zNullishString(),
    RELAYER_SHA: zNullishString(),
    RELAYER_PORT: z.coerce.number().default(8000),
    RELAYER_TOKEN_ADDRESS: z.string(),
    RELAYER_GAS_LIMIT: zBN(),
    RELAYER_MIN_BASE_FEE: zBN().default('0'),
    RELAYER_MAX_NATIVE_AMOUNT: zBN().default('0'),
    RELAYER_TREE_UPDATE_PARAMS_PATH: z.string().default('../params/tree_params.bin'),
    RELAYER_TRANSFER_PARAMS_PATH: z.string().default('../params/transfer_params.bin'),
    RELAYER_TX_VK_PATH: z.string().default('../params/transfer_verification_key.json'),
    RELAYER_REQUEST_LOG_PATH: z.string().default('./zp.log'),
    RELAYER_STATE_DIR_PATH: z.string().default('./POOL_STATE'),
    RELAYER_SENT_TX_DELAY: z.coerce.number().default(30000), // NOT USED
    RELAYER_SENT_TX_ERROR_THRESHOLD: z.coerce.number().default(3), // NOT USED
    RELAYER_PERMIT_DEADLINE_THRESHOLD_INITIAL: z.coerce.number().default(300),
    RELAYER_REQUIRE_TRACE_ID: zBooleanString().default('false'),
    RELAYER_REQUIRE_LIBJS_VERSION: zBooleanString().default('false'),
    RELAYER_EXPRESS_TRUST_PROXY: zBooleanString().default('false'),
    RELAYER_PROVER_URL: z.string(),
    RELAYER_LOG_IGNORE_ROUTES: z
      .string()
      .default('')
      .transform(rs => rs.split(' ').filter(r => r.length > 0)),
    RELAYER_LOG_HEADER_BLACKLIST: z
      .string()
      .default(defaultHeaderBlacklist)
      .transform(hs => hs.split(' ').filter(r => r.length > 0)),
    RELAYER_PERMIT_TYPE: z.nativeEnum(PermitType).default(PermitType.SaltedPermit),
    RELAYER_BLOCKED_COUNTRIES: z
      .string()
      .default('')
      .transform(cs =>
        cs.split(' ').filter(c => {
          if (c.length === 0) return false

          const exists = countryCodes.has(c)
          if (!exists) {
            logger.error(`Country code ${c} is not valid, skipping`)
          }
          return exists
        })
      ),
  })
  .and(zBaseTxGas)
  .and(zFeeManager)

const network = getNetworkConfig()

export default {
  ...zSchema.parse(process.env),
  network,
  base: getBaseConfig(),
  txManager: getTxManagerConfig(network.NETWORK),
  gasPrice: getGasPriceConfig(network.NETWORK),
  priceFeed: getPriceFeedConfig(),
}
