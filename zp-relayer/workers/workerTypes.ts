import type { Redis } from 'ioredis'
import type { Mutex } from 'async-mutex'
import type { TxManager } from '@/tx/TxManager'
import type { Pool } from '@/pool'
import type { TxPayload } from '@/queue/poolTxQueue'
import type { Circuit, IProver } from '@/prover'

export interface IWorkerBaseConfig {
  redis: Redis
  mutex: Mutex
  txManager: TxManager
}

export interface IPoolWorkerConfig extends IWorkerBaseConfig {
  validateTx: (tx: TxPayload, pool: Pool, traceId?: string) => Promise<void>
  treeProver: IProver<Circuit.Tree>
}

export interface ISentWorkerConfig extends IWorkerBaseConfig {}
export interface IDirectDepositWorkerConfig extends IWorkerBaseConfig {}
