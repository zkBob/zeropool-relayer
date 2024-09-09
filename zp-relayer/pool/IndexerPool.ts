import { toBN } from 'web3-utils'
import { BasePool } from './BasePool'

import { type PermitRecover } from '@/utils/permit/types'

export class IndexerPool extends BasePool {
  public permitRecover: PermitRecover | null = null

  protected poolName(): string { return 'indexer-pool'; }

  async init(startBlock: number | null = null, lastBlock: number | null = null) {
    if (this.isInitialized) return

    this.denominator = toBN(await this.network.pool.call('denominator'))
    this.poolId = toBN(await this.network.pool.call('pool_id'))

    if (startBlock && lastBlock) {
      await this.syncState(startBlock, lastBlock)
    }
    this.isInitialized = true
  }

  onSend(): Promise<void> {
    throw new Error('Indexer pool is read-only')
  }
  onConfirmed(): Promise<void> {
    throw new Error('Indexer pool is read-only')
  }
}
