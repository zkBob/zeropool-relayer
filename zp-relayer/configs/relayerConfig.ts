import Web3 from 'web3'
import { toBN } from 'web3-utils'
import baseConfig from './baseConfig'
import { FeeManagerType } from '@/services/fee'
import { PriceFeedType } from '@/services/price-feed'
import type { EstimationType, GasPriceKey } from '@/services/gas-price'
import { ProverType } from '@/prover'
import { countryCodes } from '@/utils/countryCodes'
import { logger } from '@/services/appLogger'
import { PermitType } from '@/utils/permit/types'

const relayerAddress = new Web3().eth.accounts.privateKeyToAccount(
  process.env.RELAYER_ADDRESS_PRIVATE_KEY as string
).address

const defaultHeaderBlacklist =
  'accept accept-language accept-encoding connection content-length content-type postman-token referer upgrade-insecure-requests'

const config = {
  ...baseConfig,
  relayerRef: process.env.RELAYER_REF || null,
  relayerSHA: process.env.RELAYER_SHA || null,
  port: parseInt(process.env.RELAYER_PORT || '8000'),
  relayerAddress,
  relayerPrivateKey: process.env.RELAYER_ADDRESS_PRIVATE_KEY as string,
  tokenAddress: process.env.RELAYER_TOKEN_ADDRESS as string,
  relayerGasLimit: toBN(process.env.RELAYER_GAS_LIMIT as string),
  baseTxGas: toBN(process.env.RELAYER_BASE_TX_GAS as string),
  relayerFee: process.env.RELAYER_FEE ? toBN(process.env.RELAYER_FEE) : null,
  maxNativeAmount: toBN(process.env.RELAYER_MAX_NATIVE_AMOUNT || '0'),
  treeUpdateParamsPath: process.env.RELAYER_TREE_UPDATE_PARAMS_PATH || './params/tree_params.bin',
  transferParamsPath: process.env.RELAYER_TRANSFER_PARAMS_PATH || './params/transfer_params.bin',
  directDepositParamsPath: process.env.RELAYER_DIRECT_DEPOSIT_PARAMS_PATH || './params/delegated_deposit_params.bin',
  txVKPath: process.env.RELAYER_TX_VK_PATH || './params/transfer_verification_key.json',
  requestLogPath: process.env.RELAYER_REQUEST_LOG_PATH || './zp.log',
  stateDirPath: process.env.RELAYER_STATE_DIR_PATH || './POOL_STATE',
  gasPriceFallback: process.env.RELAYER_GAS_PRICE_FALLBACK as string,
  gasPriceEstimationType: (process.env.RELAYER_GAS_PRICE_ESTIMATION_TYPE as EstimationType) || 'web3',
  gasPriceSpeedType: (process.env.RELAYER_GAS_PRICE_SPEED_TYPE as GasPriceKey) || 'fast',
  gasPriceFactor: parseInt(process.env.RELAYER_GAS_PRICE_FACTOR || '1'),
  gasPriceUpdateInterval: parseInt(process.env.RELAYER_GAS_PRICE_UPDATE_INTERVAL || '5000'),
  gasPriceSurplus: parseFloat(process.env.RELAYER_GAS_PRICE_SURPLUS || '0.1'),
  minGasPriceBumpFactor: parseFloat(process.env.RELAYER_MIN_GAS_PRICE_BUMP_FACTOR || '0.1'),
  maxFeeLimit: process.env.RELAYER_MAX_FEE_PER_GAS_LIMIT ? toBN(process.env.RELAYER_MAX_FEE_PER_GAS_LIMIT) : null,
  maxSentQueueSize: parseInt(process.env.RELAYER_MAX_SENT_QUEUE_SIZE || '20'),
  relayerTxRedundancy: process.env.RELAYER_TX_REDUNDANCY === 'true',
  sentTxDelay: parseInt(process.env.RELAYER_SENT_TX_DELAY || '30000'),
  sentTxLogErrorThreshold: parseInt(process.env.RELAYER_SENT_TX_ERROR_THRESHOLD || '3'),
  insufficientBalanceCheckTimeout: parseInt(process.env.RELAYER_INSUFFICIENT_BALANCE_CHECK_TIMEOUT || '60000'),
  permitDeadlineThresholdInitial: parseInt(process.env.RELAYER_PERMIT_DEADLINE_THRESHOLD_INITIAL || '300'),
  requireTraceId: process.env.RELAYER_REQUIRE_TRACE_ID === 'true',
  requireLibJsVersion: process.env.RELAYER_REQUIRE_LIBJS_VERSION === 'true',
  logIgnoreRoutes: (process.env.RELAYER_LOG_IGNORE_ROUTES || '').split(' ').filter(r => r.length > 0),
  logHeaderBlacklist: (process.env.RELAYER_LOG_HEADER_BLACKLIST || defaultHeaderBlacklist)
    .split(' ')
    .filter(r => r.length > 0),
  blockedCountries: (process.env.RELAYER_BLOCKED_COUNTRIES || '').split(' ').filter(c => {
    if (c.length === 0) return false

    const exists = countryCodes.has(c)
    if (!exists) {
      logger.error(`Country code ${c} is not valid, skipping`)
    }
    return exists
  }),
  trustProxy: process.env.RELAYER_EXPRESS_TRUST_PROXY === 'true',
  treeProverType: (process.env.RELAYER_TREE_PROVER_TYPE || ProverType.Local) as ProverType,
  directDepositProverType: (process.env.RELAYER_DD_PROVER_TYPE || ProverType.Local) as ProverType,
  feeManagerType: (process.env.RELAYER_FEE_MANAGER_TYPE || FeeManagerType.Dynamic) as FeeManagerType,
  feeManagerUpdateInterval: parseInt(process.env.RELAYER_FEE_MANAGER_UPDATE_INTERVAL || '10000'),
  feeMarginFactor: toBN(process.env.RELAYER_FEE_MARGIN_FACTOR || '100'),
  feeScalingFactor: toBN(process.env.RELAYER_FEE_SCALING_FACTOR || '100'),
  priceFeedType: (process.env.RELAYER_PRICE_FEED_TYPE || PriceFeedType.Native) as PriceFeedType,
  priceFeedContractAddress: process.env.RELAYER_PRICE_FEED_CONTRACT_ADDRESS || null,
  priceFeedBaseTokenAddress: process.env.RELAYER_PRICE_FEED_BASE_TOKEN_ADDRESS || null,
  precomputeParams: process.env.RELAYER_PRECOMPUTE_PARAMS === 'true',
  permitType: (process.env.RELAYER_PERMIT_TYPE || PermitType.SaltedPermit) as PermitType,
}

export default config
