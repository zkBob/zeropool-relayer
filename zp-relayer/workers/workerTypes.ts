import type { Redis } from 'ioredis'
import type { Mutex } from 'async-mutex'
import type { Pool } from '@/pool'
import type { TxPayload } from '@/queue/poolTxQueue'
import type { Circuit, IProver } from '@/prover'
import type { FeeManager } from '@/services/fee'

export interface IWorkerBaseConfig {
  redis: Redis
  pool: Pool
}

export interface IPoolWorkerConfig extends IWorkerBaseConfig {
  validateTx: (tx: TxPayload, pool: Pool, feeManager: FeeManager, traceId?: string) => Promise<void>
  treeProver: IProver<Circuit.Tree>
  mutex: Mutex
  feeManager: FeeManager
}

export interface ISentWorkerConfig extends IWorkerBaseConfig {
  mutex: Mutex
}

export interface IDirectDepositWorkerConfig extends IWorkerBaseConfig {
  directDepositProver: IProver<Circuit.DirectDeposit>
}
