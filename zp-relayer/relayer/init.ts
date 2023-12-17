import { Mutex } from 'async-mutex'
import { Params } from 'libzkbob-rs-node'
import { Pool } from '../pool'
import config from '../configs/relayerConfig'
import { createPoolTxWorker } from '../workers/poolTxWorker'
import { createDirectDepositWorker } from '../workers/directDepositWorker'
import { redis } from '../services/redisClient'
import { validateTx } from '../validation/tx/validateTx'
import { Circuit, IProver, LocalProver, ProverType, RemoteProver } from '../prover'
import { FeeManagerType, FeeManager, StaticFeeManager, DynamicFeeManager, OptimismFeeManager } from '../services/fee'
import type { IPriceFeed } from '../services/price-feed/IPriceFeed'
import type { IWorkerBaseConfig } from '../workers/workerTypes'
import { NativePriceFeed, OneInchPriceFeed, PriceFeedType } from '../services/price-feed'
import { Network, TronBackend, EvmBackend, NetworkBackend, isEthereum } from '../services/network'

function buildProver<T extends Circuit>(circuit: T, type: ProverType, path: string): IProver<T> {
  switch (type) {
    case ProverType.Local: {
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

export async function init() {
  let networkBackend: NetworkBackend<Network>
  const baseConfig = {
    poolAddress: config.COMMON_POOL_ADDRESS,
    tokenAddress: config.RELAYER_TOKEN_ADDRESS,
    pk: config.RELAYER_ADDRESS_PRIVATE_KEY,
    rpcUrls: config.COMMON_RPC_URL,
    requireHTTPS: config.COMMON_REQUIRE_RPC_HTTPS,
  }
  if (config.RELAYER_NETWORK === Network.Ethereum) {
    networkBackend = new EvmBackend({
      ...baseConfig,
      rpcRequestTimeout: config.COMMON_RPC_REQUEST_TIMEOUT,
      rpcSyncCheckInterval: config.COMMON_RPC_SYNC_STATE_CHECK_INTERVAL,
      jsonRpcErrorCodes: config.COMMON_JSONRPC_ERROR_CODES,
      relayerTxRedundancy: config.RELAYER_TX_REDUNDANCY,
    })
  } else if (config.RELAYER_NETWORK === Network.Tron) {
    networkBackend = new TronBackend({
      ...baseConfig,
    })
  } else {
    throw new Error('Unsupported network backend')
  }
  await networkBackend.init()

  const pool = new Pool(networkBackend)
  await pool.init()

  const mutex = new Mutex()

  const workerBaseConfig: IWorkerBaseConfig = {
    pool,
    redis,
  }

  const treeProver = buildProver(
    Circuit.Tree,
    config.RELAYER_TREE_PROVER_TYPE,
    config.RELAYER_TREE_UPDATE_PARAMS_PATH as string
  )

  const directDepositProver = buildProver(
    Circuit.DirectDeposit,
    config.RELAYER_DD_PROVER_TYPE,
    config.RELAYER_DIRECT_DEPOSIT_PARAMS_PATH as string
  )

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
      if (!isEthereum(networkBackend)) throw new Error('Dynamic fee manager is only supported for Ethereum')
      feeManager = new DynamicFeeManager(managerConfig, networkBackend.gasPrice)
      break
    }
    case FeeManagerType.Optimism: {
      if (!isEthereum(networkBackend)) throw new Error('Dynamic fee manager is only supported for Ethereum')
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
      validateTx,
      treeProver,
      mutex,
      feeManager,
    }),
    createDirectDepositWorker({
      ...workerBaseConfig,
      directDepositProver,
    }),
  ]

  const workers = await Promise.all(workerPromises)
  workers.forEach(w => w.run())

  return { feeManager, pool }
}
