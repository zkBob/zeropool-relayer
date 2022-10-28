import { pool } from './pool'
import { GasPrice } from './services/gas-price'
import { web3 } from './services/web3'
import config from './config'
import { Mutex } from 'async-mutex'

import { createPoolTxWorker } from './workers/poolTxWorker'
import { createSentTxWorker } from './workers/sentTxWorker'
import { initializeDomain } from './utils/EIP712SaltedPermit'

export async function init() {
  await initializeDomain(web3)

  await pool.init()
  const gasPriceService = new GasPrice(web3, config.gasPriceUpdateInterval, config.gasPriceEstimationType, {
    speedType: config.gasPriceSpeedType,
    factor: config.gasPriceFactor,
    maxFeeLimit: config.maxFeeLimit,
  })
  await gasPriceService.start()
  const workerMutex = new Mutex()
  ;(await createPoolTxWorker(gasPriceService, workerMutex)).run()
  ;(await createSentTxWorker(gasPriceService, workerMutex)).run()
}
