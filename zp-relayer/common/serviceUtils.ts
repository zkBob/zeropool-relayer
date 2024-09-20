import { BaseConfig } from '@/configs/baseConfig'
import { GasPriceConfig } from '@/configs/common/gasPriceConfig'
import { NetworkConfig } from '@/configs/common/networkConfig'
import { PriceFeedConfig } from '@/configs/common/priceFeedConfig'
import { TxManagerConfig } from '@/configs/common/txManagerConfig'
import { GasPrice } from '@/lib/gas-price'
import { EvmBackend, isEthereum, Network, NetworkBackend, TransactionManager } from '@/lib/network'
import { EvmTxManager } from '@/lib/network/evm/EvmTxManager'
import { IPriceFeed, NativePriceFeed, OneInchPriceFeed, PriceFeedType } from '@/lib/price-feed'
import { Circuit, IProver, LocalProver, ProverType, RemoteProver } from '@/prover'
import { Redis } from 'ioredis'
import { Params } from 'libzkbob-rs-node'

export function buildProver<T extends Circuit>(
  circuit: T,
  type: ProverType,
  path: string,
  precompute: boolean = false
): IProver<T> {
  switch (type) {
    case ProverType.Local: {
      const params = Params.fromFile(path, precompute)
      return new LocalProver(circuit, params)
    }
    case ProverType.Remote:
      return new RemoteProver(path)
    default:
      throw new Error('Unsupported prover type')
  }
}

export function buildPriceFeed(
  network: NetworkBackend<Network>,
  config: PriceFeedConfig,
  poolToken: string
): IPriceFeed {
  switch (config.PRICE_FEED_TYPE) {
    case PriceFeedType.OneInch:
      return new OneInchPriceFeed(network, config.PRICE_FEED_CONTRACT_ADDRESS, {
        poolTokenAddress: poolToken,
        customBaseTokenAddress: config.PRICE_FEED_BASE_TOKEN_ADDRESS,
      })
    case PriceFeedType.Native:
      return new NativePriceFeed()
    default:
      throw new Error('Unsupported price feed')
  }
}

export function buildNetworkBackend(
  config: BaseConfig,
  networkConfig: NetworkConfig,
  poolToken: string
): NetworkBackend<Network> {
  let networkBackend: NetworkBackend<Network>
  const baseConfig = {
    poolAddress: config.COMMON_POOL_ADDRESS,
    tokenAddress: poolToken,
    rpcUrls: config.COMMON_RPC_URL,
    requireHTTPS: config.COMMON_REQUIRE_RPC_HTTPS,
  }
  if (networkConfig.NETWORK === Network.Ethereum) {
    const evmBackend = new EvmBackend({
      ...baseConfig,
      rpcRequestTimeout: config.COMMON_RPC_REQUEST_TIMEOUT,
      rpcSyncCheckInterval: config.COMMON_RPC_SYNC_STATE_CHECK_INTERVAL,
      jsonRpcErrorCodes: config.COMMON_JSONRPC_ERROR_CODES,
      withRedundantProvider: networkConfig.TX_REDUNDANCY,
    })
    networkBackend = evmBackend
  } else if (networkConfig.NETWORK === Network.Tron) {
    throw new Error('Unsupported network backend')
  } else {
    throw new Error('Unsupported network backend')
  }
  return networkBackend
}

export function buildTxManager(
  redis: Redis,
  network: NetworkBackend<Network>,
  gasPriceConfig: GasPriceConfig<Network>,
  txManagerConfig: TxManagerConfig<Network>
): TransactionManager<any> {
  let txManager: TransactionManager<any>
  if (isEthereum(network)) {
    const gpConfig = gasPriceConfig as GasPriceConfig<Network.Ethereum>
    const gasPrice = new GasPrice(
      (network as EvmBackend).web3,
      { gasPrice: gpConfig.GAS_PRICE_FALLBACK },
      gpConfig.GAS_PRICE_UPDATE_INTERVAL,
      gpConfig.GAS_PRICE_ESTIMATION_TYPE,
      {
        speedType: gpConfig.GAS_PRICE_SPEED_TYPE,
        factor: gpConfig.GAS_PRICE_FACTOR,
        maxFeeLimit: gpConfig.MAX_FEE_PER_GAS_LIMIT,
      }
    )
    const tmConfig = txManagerConfig as TxManagerConfig<Network.Ethereum>
    txManager = new EvmTxManager((network as EvmBackend).web3Redundant, txManagerConfig.TX_PRIVATE_KEY, gasPrice, {
      redis,
      gasPriceBumpFactor: tmConfig.TX_MIN_GAS_PRICE_BUMP_FACTOR,
      gasPriceSurplus: tmConfig.TX_GAS_PRICE_SURPLUS,
      gasPriceMaxFeeLimit: tmConfig.TX_MAX_FEE_PER_GAS_LIMIT,
      waitingFundsTimeout: tmConfig.BALANCE_CHECK_TIMEOUT
    })
  } else {
    throw new Error('Unsupported network backend')
  }
  return txManager
}
