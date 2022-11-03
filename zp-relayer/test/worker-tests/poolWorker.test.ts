import { Mutex } from 'async-mutex'
import { expect } from 'chai'
import type { Proof } from 'libzkbob-rs-node'
import { Job, QueueEvents, Worker } from 'bullmq'
import { TxType } from 'zp-memo-parser'
import { web3 } from '../web3'
import { pool } from '../../pool'
import { sentTxQueue, SentTxState } from '../../queue/sentTxQueue'
import { poolTxQueue, TxPayload, PoolTxResult } from '../../queue/poolTxQueue'
import { createPoolTxWorker } from '../../workers/poolTxWorker'
import { createSentTxWorker } from '../../workers/sentTxWorker'
import { GasPrice } from '../../services/gas-price'
import { redis } from '../../services/redisClient'
import { initializeDomain } from '../../utils/EIP712SaltedPermit'
import { FlowOutputItem } from '../../../test-flow-generator/src/types'
import { disableMining, dropTransaction, mineBlock, mintTokens, newConnection } from '../utils'
import config from '../../config'
import flow from '../flows/flow_independent_deposits_5.json'

async function submitJob(item: FlowOutputItem): Promise<Job<TxPayload[], PoolTxResult[]>> {
  const job = await poolTxQueue.add('test', [
    {
      amount: '0',
      gas: '2000000',
      txProof: item.proof as Proof,
      txType: item.txType as TxType,
      rawMemo: item.transactionData.memo,
      depositSignature: item.depositSignature,
    },
  ])
  return job
}

describe('poolWorker', () => {
  let poolWorker: Worker
  let sentWorker: Worker
  let gasPriceService: GasPrice<'web3'>
  let poolQueueEvents: QueueEvents
  let sentQueueEvents: QueueEvents
  before(async () => {
    web3.eth.transactionBlockTimeout = 0
    await pool.init()
    await initializeDomain(web3)
    gasPriceService = new GasPrice(web3, 10000, 'web3', {})
    await gasPriceService.start()

    const workerMutex = new Mutex()
    poolWorker = await createPoolTxWorker(gasPriceService, workerMutex, redis)
    sentWorker = await createSentTxWorker(gasPriceService, workerMutex, redis)

    sentWorker.run()
    poolWorker.run()

    await poolWorker.waitUntilReady()
    await sentWorker.waitUntilReady()

    poolQueueEvents = new QueueEvents(poolWorker.name, { connection: redis })
    sentQueueEvents = new QueueEvents(sentWorker.name, { connection: redis })
  })

  it('executes a job', async () => {
    const deposit = flow[0]
    await mintTokens(deposit.txTypeData.from as string, parseInt(deposit.txTypeData.amount))

    // @ts-ignore
    const job = await submitJob(deposit)

    const [[txHash, sentId]] = await job.waitUntilFinished(poolQueueEvents)
    expect(txHash.length).eq(66)

    const sentJob = (await sentTxQueue.getJob(sentId)) as Job
    const [status, sentHash] = await sentJob.waitUntilFinished(sentQueueEvents)
    expect(status).eq(SentTxState.MINED)
    expect(txHash).eq(sentHash)

    const r = await web3.eth.getTransactionReceipt(sentHash)
    expect(r.status).eq(true)
  })

  it('recovers after failed re-send', async () => {
    const deposit = flow[1]
    await mintTokens(deposit.txTypeData.from as string, parseInt(deposit.txTypeData.amount))
    await disableMining()

    await sentWorker.pause()
    const initialRoot = pool.optimisticState.getMerkleRoot()
    // @ts-ignore
    const job = await submitJob(deposit as FlowOutputItem)
    const [[txHash, sentId]] = await job.waitUntilFinished(poolQueueEvents)

    // Optimistic state should be updated
    const rootAfter = pool.optimisticState.getMerkleRoot()
    expect(initialRoot).not.eq(rootAfter)

    sentWorker.resume()
    let sentJob = (await sentTxQueue.getJob(sentId)) as Job
    const [status, _] = await sentJob.waitUntilFinished(sentQueueEvents)
    expect(status).eq(SentTxState.MAX_RESEND_ATTEMPTS)

    // Rollback should be made at this point
    const recoveredRoot = pool.optimisticState.getMerkleRoot()
    expect(recoveredRoot).eq(initialRoot)

    // Get updated job data
    sentJob = (await sentTxQueue.getJob(sentId)) as Job
    expect(sentJob.attemptsMade).eq(config.maxResendAttempts + 1)

    await dropTransaction(txHash)
  })

  after(async () => {
    await poolWorker.close()
    await poolTxQueue.close()
    await poolQueueEvents.close()

    await sentWorker.close()
    await sentTxQueue.close()
    await sentQueueEvents.close()

    gasPriceService.stop()
    redis.disconnect()
  })
})
