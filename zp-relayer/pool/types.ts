import type BN from 'bn.js'
import type { Proof, VK } from 'libzkbob-rs-node'

import type { FeeManager } from '@/lib/fee'
import type { PermitType } from '@/utils/permit/types'
import type { BasePool } from './BasePool'
import type { RelayPool } from './RelayPool'

export interface Limits {
  tvlCap: BN
  tvl: BN
  dailyDepositCap: BN
  dailyDepositCapUsage: BN
  dailyWithdrawalCap: BN
  dailyWithdrawalCapUsage: BN
  dailyUserDepositCap: BN
  dailyUserDepositCapUsage: BN
  depositCap: BN
  tier: BN
  dailyUserDirectDepositCap: BN
  dailyUserDirectDepositCapUsage: BN
  directDepositCap: BN
}

export interface LimitsFetch {
  deposit: {
    singleOperation: string
    dailyForAddress: {
      total: string
      available: string
    }
    dailyForAll: {
      total: string
      available: string
    }
    poolLimit: {
      total: string
      available: string
    }
  }
  withdraw: {
    dailyForAll: {
      total: string
      available: string
    }
  }
  dd: {
    singleOperation: string
    dailyForAddress: {
      total: string
      available: string
    }
  }
  tier: string
}

export interface OptionalChecks {
  treeProof?: {
    proof: Proof
    vk: VK
  }
  fee?: {
    feeManager: FeeManager
  }
  screener?: {
    screenerUrl: string
    screenerToken: string
  }
}

export interface BaseProcessResult {
  data: string
  func: string
  nullifier?: string
  outCommit: string
  memo: string
  commitIndex: number
}

export interface DefaultPoolProcessResult extends BaseProcessResult {
  root: string
  mpc: boolean
}

export type ProcessResult<P extends BasePool> = P extends RelayPool ? BaseProcessResult : DefaultPoolProcessResult

export interface BasePoolConfig {
  statePath: string
  txVkPath: string
  eventsBatchSize: number
}

export interface PermitConfig {
  permitType: PermitType
  token: string
}
