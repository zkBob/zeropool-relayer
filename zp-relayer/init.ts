import { pool } from './pool'
import { GasPrice } from './services/gas-price'
import { web3, web3Redundant } from './services/web3'
import config from './config'
import { Mutex } from 'async-mutex'

import { createPoolTxWorker } from './workers/poolTxWorker'
import { createSentTxWorker } from './workers/sentTxWorker'
import { initializeDomain } from './utils/EIP712SaltedPermit'
import { redis } from './services/redisClient'
import { validateTx } from './validateTx'
import { TxManager } from './tx/TxManager'
import { IWorkerBaseConfig } from './workers/workerConfig'

export async function init() {
  await initializeDomain(web3)

  await pool.init()
  const gasPriceService = new GasPrice(web3, config.gasPriceUpdateInterval, config.gasPriceEstimationType, {
    speedType: config.gasPriceSpeedType,
    factor: config.gasPriceFactor,
    maxFeeLimit: config.maxFeeLimit,
  })
  await gasPriceService.start()

  const txManager = new TxManager(web3Redundant, config.relayerPrivateKey, gasPriceService)
  await txManager.init()

  const workerMutex = new Mutex()

  const baseConfig: IWorkerBaseConfig = {
    redis,
    mutex: workerMutex,
    txManager,
  }

  const workerPromises = [
    createPoolTxWorker({
      ...baseConfig,
      validateTx,
    }),
    createSentTxWorker(baseConfig),
  ].map(p => p.then(w => w.run()))

  await Promise.all(workerPromises)
}
