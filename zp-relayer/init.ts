import type Web3 from 'web3'
import { Mutex } from 'async-mutex'
import { Params } from 'libzkbob-rs-node'
import { pool } from './pool'
import { EstimationType, GasPrice } from './services/gas-price'
import { web3 } from './services/web3'
import { web3Redundant } from './services/web3Redundant'
import config from './configs/relayerConfig'
import { createPoolTxWorker } from './workers/poolTxWorker'
import { createSentTxWorker } from './workers/sentTxWorker'
import { createDirectDepositWorker } from './workers/directDepositWorker'
import { redis } from './services/redisClient'
import { validateTx } from './validation/tx/validateTx'
import { TxManager } from './tx/TxManager'
import { Circuit, IProver, LocalProver, ProverType, RemoteProver } from './prover'
import { FeeManagerType, FeeManager, StaticFeeManager, DynamicFeeManager, OptimismFeeManager } from './services/fee'
import type { IPriceFeed } from './services/price-feed/IPriceFeed'
import type { IWorkerBaseConfig } from './workers/workerTypes'
import { NativePriceFeed, OneInchPriceFeed, PriceFeedType } from './services/price-feed'

function buildProver<T extends Circuit>(circuit: T, type: ProverType, path: string): IProver<T> {
  if (type === ProverType.Local) {
    const params = Params.fromFile(path, config.precomputeParams)
    return new LocalProver(circuit, params)
  } else if (type === ProverType.Remote) {
    // TODO: test relayer with remote prover
    return new RemoteProver('')
  } else {
    throw new Error('Unsupported prover type')
  }
}

function buildFeeManager(
  type: FeeManagerType,
  priceFeed: IPriceFeed,
  gasPrice: GasPrice<EstimationType>,
  web3: Web3
): FeeManager {
  const managerConfig = {
    priceFeed,
    scaleFactor: config.feeScalingFactor,
    marginFactor: config.feeMarginFactor,
    updateInterval: config.feeManagerUpdateInterval,
    defaultFeeOptionsParams: { gasLimit: config.baseTxGas },
  }
  if (type === FeeManagerType.Static) {
    if (config.relayerFee === null) throw new Error('Static relayer fee is not set')
    return new StaticFeeManager(managerConfig, config.relayerFee)
  }
  if (type === FeeManagerType.Dynamic) {
    return new DynamicFeeManager(managerConfig, gasPrice)
  } else if (type === FeeManagerType.Optimism) {
    return new OptimismFeeManager(managerConfig, gasPrice, web3)
  } else {
    throw new Error('Unsupported fee manager')
  }
}

function buildPriceFeed(type: PriceFeedType, web3: Web3): IPriceFeed {
  if (type === PriceFeedType.OneInch) {
    if (!config.priceFeedContractAddress) throw new Error('Price feed contract address is not set')
    return new OneInchPriceFeed(web3, config.priceFeedContractAddress, {
      poolTokenAddress: config.tokenAddress,
      customBaseTokenAddress: config.priceFeedBaseTokenAddress,
    })
  } else if (type === PriceFeedType.Native) {
    return new NativePriceFeed()
  } else {
    throw new Error('Unsupported price feed')
  }
}

export async function init() {
  await pool.init()

  const gasPriceService = new GasPrice(
    web3,
    { gasPrice: config.gasPriceFallback },
    config.gasPriceUpdateInterval,
    config.gasPriceEstimationType,
    {
      speedType: config.gasPriceSpeedType,
      factor: config.gasPriceFactor,
      maxFeeLimit: config.maxFeeLimit,
    }
  )
  await gasPriceService.start()

  const txManager = new TxManager(web3Redundant, config.relayerPrivateKey, gasPriceService)
  await txManager.init()

  const mutex = new Mutex()

  const baseConfig: IWorkerBaseConfig = {
    redis,
  }

  const treeProver = buildProver(Circuit.Tree, config.treeProverType, config.treeUpdateParamsPath as string)

  const directDepositProver = buildProver(
    Circuit.DirectDeposit,
    config.directDepositProverType,
    config.directDepositParamsPath as string
  )

  const priceFeed = buildPriceFeed(config.priceFeedType, web3)
  const feeManager = buildFeeManager(config.feeManagerType, priceFeed, gasPriceService, web3)
  await feeManager.start()

  const workerPromises = [
    createPoolTxWorker({
      ...baseConfig,
      validateTx,
      treeProver,
      mutex,
      txManager,
      feeManager,
    }),
    createSentTxWorker({
      ...baseConfig,
      mutex,
      txManager,
    }),
    createDirectDepositWorker({
      ...baseConfig,
      directDepositProver,
    }),
  ]

  const workers = await Promise.all(workerPromises)
  workers.forEach(w => w.run())

  return { feeManager }
}
