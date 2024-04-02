import { TransactionManager } from '@/lib/network'
import { BasePool } from '@/pool/BasePool'
import type { Circuit, IProver } from '@/prover'
import type { Mutex } from 'async-mutex'
import type { Redis } from 'ioredis'

export interface IWorkerBaseConfig {
  redis: Redis
  pool: BasePool
}

export interface IPoolWorkerConfig extends IWorkerBaseConfig {
  mutex: Mutex
  txManager: TransactionManager<any>
}

export interface ISentWorkerConfig extends IWorkerBaseConfig {
  mutex: Mutex
  txManager: TransactionManager<any>
}

export interface IDirectDepositWorkerConfig extends IWorkerBaseConfig {
  directDepositProver: IProver<Circuit.DirectDeposit>
}
