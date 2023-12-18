import Web3 from 'web3'
import { toBN } from 'web3-utils'
import baseConfig, { zBooleanString, zNullishString } from './baseConfig'
import { FeeManagerType } from '@/services/fee'
import { PriceFeedType } from '@/services/price-feed'
import { EstimationType } from '@/services/gas-price'
import { ProverType } from '@/prover'
import { countryCodes } from '@/utils/countryCodes'
import { logger } from '@/services/appLogger'
import { PermitType } from '@/utils/permit/types'
import { TxType } from 'zp-memo-parser'
import { z } from 'zod'
import { Network } from '@/services/network/types'

const relayerAddress = new Web3().eth.accounts.privateKeyToAccount(
  process.env.RELAYER_ADDRESS_PRIVATE_KEY as string
).address

const defaultHeaderBlacklist =
  'accept accept-language accept-encoding connection content-length content-type postman-token referer upgrade-insecure-requests'

const zBN = () => z.string().transform(toBN)

const zTreeProver = z.discriminatedUnion('RELAYER_TREE_PROVER_TYPE', [
  z.object({ RELAYER_TREE_PROVER_TYPE: z.literal(ProverType.Local) }),
  z.object({ RELAYER_TREE_PROVER_TYPE: z.literal(ProverType.Remote) }), // TODO remote prover url
])

const zDirectDepositProver = z.discriminatedUnion('RELAYER_DD_PROVER_TYPE', [
  z.object({ RELAYER_DD_PROVER_TYPE: z.literal(ProverType.Local) }),
  z.object({ RELAYER_DD_PROVER_TYPE: z.literal(ProverType.Remote) }), // TODO remote prover url
])

const zPriceFeed = z.discriminatedUnion('RELAYER_PRICE_FEED_TYPE', [
  z.object({ RELAYER_PRICE_FEED_TYPE: z.literal(PriceFeedType.Native) }),
  z.object({
    RELAYER_PRICE_FEED_TYPE: z.literal(PriceFeedType.OneInch),
    RELAYER_PRICE_FEED_CONTRACT_ADDRESS: z.string(),
    RELAYER_PRICE_FEED_BASE_TOKEN_ADDRESS: z.string(),
  }),
])

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

const zGasPrice = z.object({
  RELAYER_GAS_PRICE_ESTIMATION_TYPE: z.nativeEnum(EstimationType).default(EstimationType.Web3),
  RELAYER_GAS_PRICE_UPDATE_INTERVAL: z.coerce.number().default(5000),
  RELAYER_GAS_PRICE_SURPLUS: z.coerce.number().default(0.1),
  RELAYER_MIN_GAS_PRICE_BUMP_FACTOR: z.coerce.number().default(0.1),
  RELAYER_GAS_PRICE_FACTOR: z.coerce.number().default(1),
  RELAYER_GAS_PRICE_SPEED_TYPE: z.string().default('fast'),
  RELAYER_GAS_PRICE_FALLBACK: z.string(),
  RELAYER_MAX_FEE_PER_GAS_LIMIT: zBN().nullable().default(null),
})
z.discriminatedUnion('RELAYER_GAS_PRICE_ESTIMATION_TYPE', [
  z.object({ RELAYER_GAS_PRICE_ESTIMATION_TYPE: z.literal(EstimationType.EIP1559) }),
  z.object({ RELAYER_GAS_PRICE_ESTIMATION_TYPE: z.literal(EstimationType.Web3) }),
  z.object({
    RELAYER_GAS_PRICE_ESTIMATION_TYPE: z.literal(EstimationType.Oracle),
    RELAYER_GAS_PRICE_FALLBACK: z.string(),
  }),
])

const zGuards = z.object({
  RELAYER_GUARDS_CONFIG_PATH: z.string().optional(),
  RELAYER_MPC_GUARD_CONTRACT: z.string().optional(),
})

const zSchema = z
  .object({
    RELAYER_NETWORK: z.nativeEnum(Network),
    RELAYER_REF: zNullishString(),
    RELAYER_SHA: zNullishString(),
    RELAYER_PORT: z.coerce.number().default(8000),
    RELAYER_ADDRESS_PRIVATE_KEY: z.string(),
    RELAYER_TOKEN_ADDRESS: z.string(),
    RELAYER_GAS_LIMIT: zBN(),
    RELAYER_MIN_BASE_FEE: zBN().default('0'),
    RELAYER_MAX_NATIVE_AMOUNT: zBN().default('0'),
    RELAYER_TREE_UPDATE_PARAMS_PATH: z.string().default('./params/tree_params.bin'),
    RELAYER_TRANSFER_PARAMS_PATH: z.string().default('./params/transfer_params.bin'),
    RELAYER_DIRECT_DEPOSIT_PARAMS_PATH: z.string().default('./params/delegated_deposit_params.bin'),
    RELAYER_TX_VK_PATH: z.string().default('./params/transfer_verification_key.json'),
    RELAYER_REQUEST_LOG_PATH: z.string().default('./zp.log'),
    RELAYER_STATE_DIR_PATH: z.string().default('./POOL_STATE'),
    RELAYER_GAS_PRICE_FALLBACK: z.string(),
    RELAYER_TX_REDUNDANCY: zBooleanString().default('false'),
    RELAYER_SENT_TX_DELAY: z.coerce.number().default(30000),
    RELAYER_SENT_TX_ERROR_THRESHOLD: z.coerce.number().default(3),
    RELAYER_INSUFFICIENT_BALANCE_CHECK_TIMEOUT: z.coerce.number().default(60000),
    RELAYER_PERMIT_DEADLINE_THRESHOLD_INITIAL: z.coerce.number().default(300),
    RELAYER_REQUIRE_TRACE_ID: zBooleanString().default('false'),
    RELAYER_REQUIRE_LIBJS_VERSION: zBooleanString().default('false'),
    RELAYER_EXPRESS_TRUST_PROXY: zBooleanString().default('false'),
    RELAYER_PRECOMPUTE_PARAMS: zBooleanString().default('false'),
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
  .and(zTreeProver)
  .and(zDirectDepositProver)
  .and(zPriceFeed)
  .and(zBaseTxGas)
  .and(zFeeManager)
  .and(zGasPrice)
  .and(zGuards)

const config = zSchema.parse(process.env)

export default {
  ...config,
  ...baseConfig,
  RELAYER_ADDRESS: relayerAddress,
}
