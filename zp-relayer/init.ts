import type Web3 from 'web3'
import { toBN } from 'web3-utils'
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
import { createForcedExitWorker } from './workers/forcedExitWorker'
import { EventWatcher } from './services/EventWatcher'
import { forcedExitQueue } from './queue/forcedExitQueue'

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
  await priceFeed.init()
  const feeManager = buildFeeManager(config.feeManagerType, priceFeed, gasPriceService, web3)
  await feeManager.start()

  const forcedExitWatcher = new EventWatcher({
    name: 'forced-exit',
    startBlock: config.forcedExitStartBlock,
    blockConfirmations: config.forcedExitBlockConfirmations,
    eventName: 'CommitForcedExit',
    eventPollingInterval: config.forcedExitPollingInterval,
    eventsProcessingBatchSize: config.eventsProcessingBatchSize,
    redis,
    web3,
    contract: pool.PoolInstance,
    callback: async events => {
      for (let event of events) {
        const nullifier = event.returnValues.nullifier as string
        const exitEnd = toBN(event.returnValues.exitEnd)
        const now = toBN(Math.floor(Date.now() / 1000))
        await forcedExitQueue.add(
          nullifier,
          { nullifier },
          {
            // add a 10 minute buffer
            delay: exitEnd.sub(now).addn(600).muln(1000).toNumber(),
          }
        )
      }
    },
  })
  await forcedExitWatcher.init()
  forcedExitWatcher.run()

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
    createForcedExitWorker({
      ...baseConfig,
    }),
  ]

  const workers = await Promise.all(workerPromises)
  workers.forEach(w => w.run())

  return { feeManager }
}
