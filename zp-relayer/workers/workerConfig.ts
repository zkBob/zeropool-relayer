import type { Redis } from 'ioredis'
import type { Mutex } from 'async-mutex'
import type { TxManager } from '@/tx/TxManager'
import type { Pool } from '@/pool'
import type { TxPayload } from '@/queue/poolTxQueue'

export interface IWorkerBaseConfig {
  redis: Redis
  mutex: Mutex
  txManager: TxManager
}

export interface IPoolWorkerConfig extends IWorkerBaseConfig {
  validateTx: (tx: TxPayload, pool: Pool, traceId?: string) => Promise<void>
}

export interface ISentWorkerConfig extends IWorkerBaseConfig {}
