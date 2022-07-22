import { pool } from './pool'
import { GasPrice } from './services/GasPrice'
import { web3 } from './services/web3'
import config from './config'
import { Mutex } from 'async-mutex'

import { createPoolTxWorker } from './poolTxWorker'
import { createSentTxWorker } from './sentTxWorker'

export async function init() {
  await pool.init()
  const gasPriceService = new GasPrice(web3, config.gasPriceUpdateInterval, config.gasPriceEstimationType, {})
  await gasPriceService.start()
  const workerMutex = new Mutex()
  ;(await createPoolTxWorker(gasPriceService, workerMutex)).run()
  ;(await createSentTxWorker(gasPriceService, workerMutex)).run()
}
