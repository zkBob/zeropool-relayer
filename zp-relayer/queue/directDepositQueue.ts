import { Queue } from 'bullmq'
import { redis } from '@/services/redisClient'
import { DIRECT_DEPOSIT_QUEUE_NAME } from '@/utils/constants'

interface ZkAddress {
  diversifier: string
  pk: string
}

export interface DirectDeposit {
  sender: string
  nonce: string
  fallbackUser: string
  zkAddress: ZkAddress
  deposit: string
}

export type DirectDepositResult = [string, string]

export const directDepositQueue = new Queue<DirectDeposit[], DirectDepositResult>(DIRECT_DEPOSIT_QUEUE_NAME, {
  connection: redis,
})
