import type { AbiItem } from 'web3-utils'
import type { DirectDeposit } from '@/queue/poolTxQueue'
import { web3 } from '@/services/web3'
import PoolAbi from '@/abi/pool-abi.json'
import DirectDepositQueueAbi from '@/abi/direct-deposit-queue-abi.json'
import config from '@/configs/watcherConfig'
import { logger } from '@/services/appLogger'
import { redis } from '@/services/redisClient'
import { BatchCache } from './BatchCache'
import { validateDirectDeposit } from '@/validation/tx/validateDirectDeposit'
import { directDepositQueue } from '@/queue/directDepositQueue'
import { EventWatcher } from '../services/EventWatcher'

export function parseDirectDepositEvent(o: Record<string, any>): DirectDeposit {
  const dd: DirectDeposit = {
    sender: o.sender,
    nonce: o.nonce,
    fallbackUser: o.fallbackUser,
    zkAddress: {
      diversifier: o.zkAddress.diversifier,
      pk: o.zkAddress.pk,
    },
    deposit: o.deposit,
  }

  return dd
}

async function init() {
  const PoolInstance = new web3.eth.Contract(PoolAbi as AbiItem[], config.poolAddress)
  const queueAddress = await PoolInstance.methods.direct_deposit_queue().call()
  const DirectDepositQueueInstance = new web3.eth.Contract(DirectDepositQueueAbi as AbiItem[], queueAddress)

  const batch = new BatchCache<DirectDeposit>(
    config.directDepositBatchSize,
    config.directDepositBatchTtl,
    ds => {
      logger.info('Adding direct-deposit events to queue', { count: ds.length })
      directDepositQueue.add('', ds)
    },
    dd => validateDirectDeposit(dd, DirectDepositQueueInstance),
    redis
  )
  await batch.init()

  const watcher = new EventWatcher({
    name: 'direct-deposit',
    startBlock: config.startBlock,
    blockConfirmations: config.blockConfirmations,
    eventName: 'SubmitDirectDeposit',
    eventPollingInterval: config.eventPollingInterval,
    eventsProcessingBatchSize: config.eventsProcessingBatchSize,
    redis,
    web3,
    contract: DirectDepositQueueInstance,
    callback: async events => {
      const directDeposits: [string, DirectDeposit][] = []
      for (let event of events) {
        const dd = parseDirectDepositEvent(event.returnValues)
        directDeposits.push([dd.nonce, dd])
      }

      await batch.add(directDeposits)
    },
  })
  await watcher.init()
  return watcher
}

init().then(w => w.run())
