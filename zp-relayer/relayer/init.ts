import { GasPriceConfig } from '@/configs/common/gasPriceConfig'
import { TxManagerConfig } from '@/configs/common/txManagerConfig'
import { RelayPool } from '@/pool/RelayPool'
import { GasPrice } from '@/services/gas-price'
import { EvmTxManager } from '@/services/network/evm/EvmTxManager'
import { createSentTxWorker } from '@/workers/sentTxWorker'
import { Mutex } from 'async-mutex'
import { Params } from 'libzkbob-rs-node'
import config from '../configs/relayerConfig'
import { Circuit, IProver, LocalProver, ProverType, RemoteProver } from '../prover'
import { DynamicFeeManager, FeeManager, FeeManagerType, OptimismFeeManager, StaticFeeManager } from '../services/fee'
import { EvmBackend, Network, NetworkBackend, TransactionManager, isEthereum } from '../services/network'
import { NativePriceFeed, OneInchPriceFeed, PriceFeedType } from '../services/price-feed'
import type { IPriceFeed } from '../services/price-feed/IPriceFeed'
import { redis } from '../services/redisClient'
import { createPoolTxWorker } from '../workers/poolTxWorker'
import type { IWorkerBaseConfig } from '../workers/workerTypes'

function buildProver<T extends Circuit>(circuit: T, type: ProverType, path: string): IProver<T> {
  switch (type) {
    case ProverType.Local: {
      console.log(path)
      const params = Params.fromFile(path, config.RELAYER_PRECOMPUTE_PARAMS)
      return new LocalProver(circuit, params)
    }
    case ProverType.Remote:
      // TODO: test relayer with remote prover
      return new RemoteProver(path)
    default:
      throw new Error('Unsupported prover type')
  }
}

function buildPriceFeed(network: NetworkBackend<Network>): IPriceFeed {
  switch (config.RELAYER_PRICE_FEED_TYPE) {
    case PriceFeedType.OneInch:
      return new OneInchPriceFeed(network, config.RELAYER_PRICE_FEED_CONTRACT_ADDRESS, {
        poolTokenAddress: config.RELAYER_TOKEN_ADDRESS,
        customBaseTokenAddress: config.RELAYER_PRICE_FEED_BASE_TOKEN_ADDRESS,
      })
    case PriceFeedType.Native:
      return new NativePriceFeed()
    default:
      throw new Error('Unsupported price feed')
  }
}

function initNetwork(): [NetworkBackend<Network>, TransactionManager<any>] {
  let networkBackend: NetworkBackend<Network>
  let txManager: TransactionManager<any>
  const baseConfig = {
    poolAddress: config.COMMON_POOL_ADDRESS,
    tokenAddress: config.RELAYER_TOKEN_ADDRESS,
    rpcUrls: config.COMMON_RPC_URL,
    requireHTTPS: config.COMMON_REQUIRE_RPC_HTTPS,
  }
  if (config.RELAYER_NETWORK === Network.Ethereum) {
    const evmBackend = new EvmBackend({
      ...baseConfig,
      rpcRequestTimeout: config.COMMON_RPC_REQUEST_TIMEOUT,
      rpcSyncCheckInterval: config.COMMON_RPC_SYNC_STATE_CHECK_INTERVAL,
      jsonRpcErrorCodes: config.COMMON_JSONRPC_ERROR_CODES,
      withRedundantProvider: config.RELAYER_TX_REDUNDANCY,
    })
    const gasPriceConfig = config.gasPrice as GasPriceConfig<Network.Ethereum>
    const gasPrice = new GasPrice(
      evmBackend.web3,
      { gasPrice: gasPriceConfig.GAS_PRICE_FALLBACK },
      gasPriceConfig.GAS_PRICE_UPDATE_INTERVAL,
      gasPriceConfig.GAS_PRICE_ESTIMATION_TYPE,
      {
        speedType: gasPriceConfig.GAS_PRICE_SPEED_TYPE,
        factor: gasPriceConfig.GAS_PRICE_FACTOR,
        maxFeeLimit: gasPriceConfig.MAX_FEE_PER_GAS_LIMIT,
      }
    )
    const txManagerConfig = config.txManager as TxManagerConfig<Network.Ethereum>
    txManager = new EvmTxManager(evmBackend.web3Redundant, txManagerConfig.TX_PRIVATE_KEY, gasPrice, {
      redis,
      gasPriceBumpFactor: txManagerConfig.TX_MIN_GAS_PRICE_BUMP_FACTOR,
      gasPriceSurplus: txManagerConfig.TX_GAS_PRICE_SURPLUS,
      gasPriceMaxFeeLimit: txManagerConfig.TX_MAX_FEE_PER_GAS_LIMIT,
    })
    networkBackend = evmBackend
  } else if (config.RELAYER_NETWORK === Network.Tron) {
    throw new Error('Unsupported network backend')
  } else {
    throw new Error('Unsupported network backend')
  }
  return [networkBackend, txManager]
}

export async function init() {
  const [networkBackend, txManager] = initNetwork()
  const pool = new RelayPool(networkBackend, {
    statePath: config.RELAYER_STATE_DIR_PATH,
    txVkPath: config.RELAYER_TX_VK_PATH,
    eventsBatchSize: config.COMMON_EVENTS_PROCESSING_BATCH_SIZE,
  })

  await Promise.all([txManager.init(), networkBackend.init(), pool.init()])

  const mutex = new Mutex()

  const workerBaseConfig: IWorkerBaseConfig = {
    pool,
    redis,
  }

  const priceFeed = buildPriceFeed(networkBackend)
  await priceFeed.init()

  let feeManager: FeeManager
  const managerConfig = {
    priceFeed,
    scaleFactor: config.RELAYER_FEE_SCALING_FACTOR,
    marginFactor: config.RELAYER_FEE_MARGIN_FACTOR,
    updateInterval: config.RELAYER_FEE_MANAGER_UPDATE_INTERVAL,
  }
  switch (config.RELAYER_FEE_MANAGER_TYPE) {
    case FeeManagerType.Static:
      feeManager = new StaticFeeManager(managerConfig, config.RELAYER_FEE)
      break
    case FeeManagerType.Dynamic: {
      if (!isEthereum(networkBackend)) throw new Error('Dynamic fee manager is supported only for Ethereum')
      feeManager = new DynamicFeeManager(managerConfig, (txManager as EvmTxManager).gasPrice)
      break
    }
    case FeeManagerType.Optimism: {
      if (!isEthereum(networkBackend)) throw new Error('Dynamic fee manager is supported only for Ethereum')
      feeManager = new OptimismFeeManager(managerConfig, networkBackend)
      break
    }
    default:
      throw new Error('Unsupported fee manager')
  }
  await feeManager.start()

  const workerPromises = [
    createPoolTxWorker({
      ...workerBaseConfig,
      mutex,
      txManager,
    }),
    createSentTxWorker({
      ...workerBaseConfig,
      mutex,
      txManager,
    }),
  ]

  const workers = await Promise.all(workerPromises)
  workers.forEach(w => w.run())

  return { feeManager, pool }
}
