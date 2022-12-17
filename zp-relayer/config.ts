import './env'
import Web3 from 'web3'
import { toBN } from 'web3-utils'
import type { EstimationType, GasPriceKey } from './services/gas-price'

const relayerAddress = new Web3().eth.accounts.privateKeyToAccount(
  process.env.RELAYER_ADDRESS_PRIVATE_KEY as string
).address

const config = {
  port: parseInt(process.env.PORT || '8000'),
  relayerAddress,
  relayerPrivateKey: process.env.RELAYER_ADDRESS_PRIVATE_KEY as string,
  poolAddress: process.env.POOL_ADDRESS,
  tokenAddress: process.env.TOKEN_ADDRESS,
  relayerGasLimit: toBN(process.env.RELAYER_GAS_LIMIT as string),
  relayerFee: toBN(process.env.RELAYER_FEE as string),
  maxFaucet: toBN(process.env.MAX_NATIVE_AMOUNT_FAUCET as string),
  treeUpdateParamsPath: process.env.TREE_UPDATE_PARAMS_PATH || './params/tree_params.bin',
  transferParamsPath: process.env.TRANSFER_PARAMS_PATH || './params/transfer_params.bin',
  txVKPath: process.env.TX_VK_PATH || './params/transfer_verification_key.json',
  stateDirPath: process.env.STATE_DIR_PATH || './POOL_STATE',
  gasPriceFallback: process.env.GAS_PRICE_FALLBACK as string,
  gasPriceEstimationType: (process.env.GAS_PRICE_ESTIMATION_TYPE as EstimationType) || 'web3',
  gasPriceSpeedType: (process.env.GAS_PRICE_SPEED_TYPE as GasPriceKey) || 'fast',
  gasPriceFactor: parseInt(process.env.GAS_PRICE_FACTOR || '1'),
  gasPriceUpdateInterval: parseInt(process.env.GAS_PRICE_UPDATE_INTERVAL || '5000'),
  gasPriceSurplus: parseFloat(process.env.GAS_PRICE_SURPLUS || '0.1'),
  minGasPriceBumpFactor: parseFloat(process.env.MIN_GAS_PRICE_BUMP_FACTOR || '0.1'),
  maxFeeLimit: process.env.MAX_FEE_PER_GAS_LIMIT ? toBN(process.env.MAX_FEE_PER_GAS_LIMIT) : null,
  maxSentQueueSize: parseInt(process.env.MAX_SENT_QUEUE_SIZE || '20'),
  startBlock: parseInt(process.env.START_BLOCK || '0'),
  eventsProcessingBatchSize: parseInt(process.env.EVENTS_PROCESSING_BATCH_SIZE || '10000'),
  logLevel: process.env.RELAYER_LOG_LEVEL || 'debug',
  redisUrl: process.env.RELAYER_REDIS_URL as string,
  rpcUrl: (process.env.RPC_URL as string).split(' ').filter(url => url.length > 0),
  sentTxDelay: parseInt(process.env.SENT_TX_DELAY || '30000'),
  rpcRequestTimeout: parseInt(process.env.RPC_REQUEST_TIMEOUT || '1000'),
  permitDeadlineThresholdInitial: parseInt(process.env.PERMIT_DEADLINE_THRESHOLD_INITIAL || '300'),
  relayerJsonRpcErrorCodes: (process.env.RELAYER_JSONRPC_ERROR_CODES || '-32603,-32002,-32005').split(',').map(s => parseInt(s, 10))
}

export default config
