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
import { createDirectDepositWorker } from './workers/directDepositWorker'

function buildProver<T extends Circuit>(circuit: T, type: ProverType, path: string): IProver<T> {
  if (type === ProverType.Local) {
    const params = Params.fromFile(path)
    return new LocalProver(circuit, params)
  } else {
    // TODO: add env url
    return new RemoteProver('')
  }
}

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

  const workerPromises = [
    createPoolTxWorker({
      ...baseConfig,
      validateTx,
      treeProver,
      mutex,
      txManager,
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
}
