import config from '@/configs/commitmentWatcherConfig'
import { GasPriceConfig } from '@/configs/common/gasPriceConfig'
import { TxManagerConfig } from '@/configs/common/txManagerConfig'
import { FinalizerPool, PendingCommitment } from '@/pool/FinalizerPool'
import { Circuit, IProver, LocalProver, ProverType } from '@/prover'
import { JobState, WorkerTxType, poolTxQueue } from '@/queue/poolTxQueue'
import { logger } from '@/services/appLogger'
import { GasPrice } from '@/services/gas-price'
import { EvmBackend, Network, NetworkBackend, TransactionManager } from '@/services/network'
import { EvmTxManager } from '@/services/network/evm/EvmTxManager'
import { redis } from '@/services/redisClient'
import { createPoolTxWorker } from '@/workers/poolTxWorker'
import { createSentTxWorker } from '@/workers/sentTxWorker'
import { IWorkerBaseConfig } from '@/workers/workerTypes'
import { Mutex } from 'async-mutex'
import BN from 'bn.js'
import { Params } from 'libzkbob-rs-node'
import { toBN } from 'web3-utils'

function buildProver<T extends Circuit>(circuit: T, type: ProverType, path: string): IProver<T> {
  switch (type) {
    case ProverType.Local: {
      const params = Params.fromFile(path, config.COMMITMENT_WATCHER_PRECOMPUTE_PARAMS)
      return new LocalProver(circuit, params)
    }
    default:
      throw new Error('Unsupported prover type')
  }
}

function initNetwork(): [NetworkBackend<Network>, TransactionManager<any>] {
  let networkBackend: NetworkBackend<Network>
  let txManager: TransactionManager<any>
  const baseConfig = {
    poolAddress: config.COMMON_POOL_ADDRESS,
    tokenAddress: config.COMMITMENT_WATCHER_TOKEN_ADDRESS,
    rpcUrls: config.COMMON_RPC_URL,
    requireHTTPS: config.COMMON_REQUIRE_RPC_HTTPS,
  }
  if (config.COMMITMENT_WATCHER_NETWORK === Network.Ethereum) {
    const evmBackend = new EvmBackend({
      ...baseConfig,
      rpcRequestTimeout: config.COMMON_RPC_REQUEST_TIMEOUT,
      rpcSyncCheckInterval: config.COMMON_RPC_SYNC_STATE_CHECK_INTERVAL,
      jsonRpcErrorCodes: config.COMMON_JSONRPC_ERROR_CODES,
      withRedundantProvider: config.COMMITMENT_WATCHER_TX_REDUNDANCY,
    })
    const gasPriceConfig = config.gasPrice as GasPriceConfig<Network.Ethereum>
    const gasPrice = new GasPrice(
      evmBackend.web3,
      { gasPrice: gasPriceConfig.GAS_PRICE_FALLBACK },
      gasPriceConfig.GAS_PRICE_UPDATE_INTERVAL,
      gasPriceConfig.GAS_PRICE_ESTIMATION_TYPE,
      {
        speedType: gasPriceConfig.GAS_PRICE_SPEED_TYPE,
        factor: gasPriceConfig.GAS_PRICE_FACTOR,
        maxFeeLimit: gasPriceConfig.MAX_FEE_PER_GAS_LIMIT,
      }
    )
    const txManagerConfig = config.txManager as TxManagerConfig<Network.Ethereum>
    txManager = new EvmTxManager(evmBackend.web3, txManagerConfig.TX_PRIVATE_KEY, gasPrice, {
      redis,
      gasPriceBumpFactor: txManagerConfig.TX_MIN_GAS_PRICE_BUMP_FACTOR,
      gasPriceSurplus: txManagerConfig.TX_GAS_PRICE_SURPLUS,
      gasPriceMaxFeeLimit: txManagerConfig.TX_MAX_FEE_PER_GAS_LIMIT,
    })
    networkBackend = evmBackend
  } else if (config.COMMITMENT_WATCHER_NETWORK === Network.Tron) {
    throw new Error('Unsupported network backend')
  } else {
    throw new Error('Unsupported network backend')
  }
  return [networkBackend, txManager]
}

async function processCommitment(pendingCommitment: PendingCommitment) {
  const { timestamp, privilegedProver, fee, commitment, gracePeriodEnd } = pendingCommitment

  const currentTimestamp = new BN(Math.floor(Date.now() / 1000))

  if (privilegedProver !== config.txManager.TX_ADDRESS && currentTimestamp.lt(toBN(gracePeriodEnd))) {
    logger.info('Not allowed to submit the proof yet, waiting...')
    return
  }

  if (await poolTxQueue.getJob(commitment)) {
    logger.info('Job already created, waiting...', { commitment })
    return
  }

  const job = await poolTxQueue.add(
    'tx',
    {
      type: WorkerTxType.Finalize,
      transaction: {
        txHash: null,
        state: JobState.WAITING,
        outCommit: commitment,
        privilegedProver,
        fee,
        timestamp,
        gracePeriodEnd,
      },
    },
    {
      jobId: commitment,
    }
  )
  logger.debug(`Added poolTxWorker job: ${job.id}`)
}

async function runWatcher(pool: FinalizerPool) {
  try {
    const pendingCommitment = await pool.fetchCommitment()
    if (pendingCommitment) {
      await processCommitment(pendingCommitment)
    }
  } catch (e) {
    logger.error(e)
  }

  setTimeout(() => {
    runWatcher(pool)
  }, config.COMMITMENT_WATCHER_FETCH_INTERVAL)
}

export async function init() {
  const [networkBackend, txManager] = initNetwork()
  const pool = new FinalizerPool(networkBackend, {
    statePath: config.COMMITMENT_WATCHER_STATE_DIR_PATH,
    txVkPath: config.COMMITMENT_WATCHER_TX_VK_PATH,
    eventsBatchSize: config.COMMON_EVENTS_PROCESSING_BATCH_SIZE,
  })
  const treeProver = buildProver(
    Circuit.Tree,
    ProverType.Local,
    config.COMMITMENT_WATCHER_TREE_UPDATE_PARAMS_PATH as string
  )
  await pool.init(true, treeProver)
  await txManager.init()

  const workerBaseConfig: IWorkerBaseConfig = {
    pool,
    redis,
  }

  const mutex = new Mutex()

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

  runWatcher(pool)
}
