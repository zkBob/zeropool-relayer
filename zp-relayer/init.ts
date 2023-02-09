import { pool } from './pool'
import { GasPrice } from './services/gas-price'
import { web3 } from './services/web3'
import { web3Redundant } from './services/web3Redundant'
import config from './configs/relayerConfig'
import { Mutex } from 'async-mutex'

import { createPoolTxWorker } from './workers/poolTxWorker'
import { createSentTxWorker } from './workers/sentTxWorker'
import { initializeDomain } from './utils/EIP712SaltedPermit'
import { redis } from './services/redisClient'
import { validateTx } from './validation/tx/validateTx'
import { TxManager } from './tx/TxManager'
import { Circuit, LocalProver } from './prover'
import type { IWorkerBaseConfig } from './workers/workerTypes'

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

  const treeProver = new LocalProver(Circuit.Tree, pool.treeParams)
  const workerPromises = [
    createPoolTxWorker({
      ...baseConfig,
      validateTx,
      treeProver,
    }),
    createSentTxWorker(baseConfig),
  ]

  const workers = await Promise.all(workerPromises)
  workers.forEach(w => w.run())
}
