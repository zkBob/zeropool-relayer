import { Mutex } from 'async-mutex'
import { Params } from 'libzkbob-rs-node'
import { pool } from './pool'
import { GasPrice } from './services/gas-price'
import { web3 } from './services/web3'
import { web3Redundant } from './services/web3Redundant'
import config, { ProverType } from './configs/relayerConfig'
import { createPoolTxWorker } from './workers/poolTxWorker'
import { createSentTxWorker } from './workers/sentTxWorker'
import { initializeDomain } from './utils/EIP712SaltedPermit'
import { redis } from './services/redisClient'
import { validateTx } from './validation/tx/validateTx'
import { TxManager } from './tx/TxManager'
import { Circuit, IProver, LocalProver, RemoteProver } from './prover'
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

  let treeProver: IProver<Circuit.Tree>
  if (config.treeProverType === ProverType.Local) {
    const params = Params.fromFile(config.treeUpdateParamsPath as string)
    treeProver = new LocalProver(Circuit.Tree, params)
  } else {
    treeProver = new RemoteProver(Circuit.Tree)
  }

  let directDepositProver: IProver<Circuit.DirectDeposit>
  if (config.directDepositProverType === ProverType.Local) {
    directDepositProver = new LocalProver(Circuit.DirectDeposit, config.directDepositParamsPath as string)
  } else {
    directDepositProver = new RemoteProver(Circuit.DirectDeposit)
  }

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
