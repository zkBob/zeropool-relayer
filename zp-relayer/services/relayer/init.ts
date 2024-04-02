import { buildNetworkBackend, buildPriceFeed, buildTxManager } from '@/common/serviceUtils'
import config from '@/configs/relayerConfig'
import { DynamicFeeManager, FeeManager, FeeManagerType, OptimismFeeManager, StaticFeeManager } from '@/lib/fee'
import { isEthereum } from '@/lib/network'
import { EvmTxManager } from '@/lib/network/evm/EvmTxManager'
import { redis } from '@/lib/redisClient'
import { RelayPool } from '@/pool/RelayPool'
import { createPoolTxWorker } from '@/workers/poolTxWorker'
import { createSentTxWorker } from '@/workers/sentTxWorker'
import type { IWorkerBaseConfig } from '@/workers/workerTypes'
import { Mutex } from 'async-mutex'

export async function init() {
  const networkBackend = buildNetworkBackend(config.base, config.network, config.RELAYER_TOKEN_ADDRESS)
  const txManager = buildTxManager(redis, networkBackend, config.gasPrice, config.txManager)
  const pool = new RelayPool(networkBackend, {
    statePath: config.RELAYER_STATE_DIR_PATH,
    txVkPath: config.RELAYER_TX_VK_PATH,
    eventsBatchSize: config.base.COMMON_EVENTS_PROCESSING_BATCH_SIZE,
  })

  await Promise.all([
    txManager.init(),
    networkBackend.init(),
    pool.init(
      {
        permitType: config.RELAYER_PERMIT_TYPE,
        token: config.RELAYER_TOKEN_ADDRESS,
      },
      config.txManager.TX_ADDRESS
    ),
  ])

  const mutex = new Mutex()

  const workerBaseConfig: IWorkerBaseConfig = {
    pool,
    redis,
  }

  const priceFeed = buildPriceFeed(networkBackend, config.priceFeed, config.RELAYER_TOKEN_ADDRESS)
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
