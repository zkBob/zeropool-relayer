import { Mutex } from 'async-mutex'
import { expect } from 'chai'
import { web3 } from '../web3'
import { poolTxQueue } from '../../queue/poolTxQueue'
import { GasPrice } from '../../services/gas-price'
import { createPoolTxWorker } from '../../workers/poolTxWorker'
import { initializeDomain } from '../../utils/EIP712SaltedPermit'
import { pool } from '../../pool'
import { redis } from '../../services/redisClient'
import type { Proof } from 'libzkbob-rs-node'
import { TxType } from 'zp-memo-parser'
import { QueueEvents, Worker } from 'bullmq'
import flow from '../flows/test_flow.json'
import { disableMining, mineBlock, mintTokens } from '../utils'

describe('poolWorker', () => {
  let poolWorker: Worker
  let gasPriceService: GasPrice<'web3'>
  let queueEvents: QueueEvents
  before(async () => {
    await pool.init()
    await initializeDomain(web3)
    gasPriceService = new GasPrice(web3, 10000, 'web3', {})
    await gasPriceService.start()

    const workerMutex = new Mutex()
    poolWorker = await createPoolTxWorker(gasPriceService, workerMutex, redis)
    poolWorker.run()
    await poolWorker.waitUntilReady()

    queueEvents = new QueueEvents(poolWorker.name, { connection: redis })
  })
  it('executes a job', async () => {
    await mintTokens(flow[0].txTypeData.from as string, 10)
    const job = await poolTxQueue.add('test', [
      {
        amount: '0',
        gas: '2000000',
        txProof: flow[0].proof as Proof,
        txType: TxType.PERMITTABLE_DEPOSIT,
        rawMemo: flow[0].transactionData.memo,
        depositSignature: flow[0].depositSignature,
      },
    ])

    const [txHash] = await job.waitUntilFinished(queueEvents)
    expect(txHash.length).to.eq(66)
  })

  after(async () => {
    await poolWorker.close()
    await poolTxQueue.close()
    await queueEvents.close()
    gasPriceService.stop()
    redis.disconnect()
  })
})
