import { Mutex } from 'async-mutex'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import { Job, QueueEvents, Worker } from 'bullmq'
import { TxType } from 'zp-memo-parser'
import { web3 } from './web3'
import { pool } from '../../pool'
import { sentTxQueue, SentTxState } from '../../queue/sentTxQueue'
import { poolTxQueue, TxPayload, PoolTxResult } from '../../queue/poolTxQueue'
import { createPoolTxWorker } from '../../workers/poolTxWorker'
import { createSentTxWorker } from '../../workers/sentTxWorker'
import { GasPrice } from '../../services/gas-price'
import { redis } from '../../services/redisClient'
import { initializeDomain } from '../../utils/EIP712SaltedPermit'
import { FlowOutputItem, PermitDepositOutputItem } from '../../../test-flow-generator/src/types'
import { disableMining, enableMining, mintTokens, newConnection } from './utils'
import flow from '../flows/flow_independent_deposits_5.json'
import flowDependentDeposits from '../flows/flow_dependent_deposits_2.json'

import { validateTx } from '../../validateTx'
import config from '../../config'

chai.use(chaiAsPromised)
const expect = chai.expect

async function submitJob(item: FlowOutputItem<TxType>): Promise<Job<TxPayload[], PoolTxResult[]>> {
  const job = await poolTxQueue.add('test', [
    {
      amount: '0',
      gas: '2000000',
      txProof: item.proof,
      txType: item.txType,
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
  let workerMutex: Mutex
  before(async () => {
    web3.eth.transactionBlockTimeout = 0
    await pool.init()
    await initializeDomain(web3)
    gasPriceService = new GasPrice(web3, 10000, 'web3', {})
    await gasPriceService.start()

    workerMutex = new Mutex()
    poolWorker = await createPoolTxWorker(gasPriceService, validateTx, workerMutex, redis)
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

  it('should re-send tx', async () => {
    const deposit = flow[1]
    await mintTokens(deposit.txTypeData.from as string, parseInt(deposit.txTypeData.amount))
    await disableMining()

    sentWorker.on('progress', async () => {
      await enableMining()
    })

    // @ts-ignore
    const job = await submitJob(deposit)

    const [[txHash, sentId]] = await job.waitUntilFinished(poolQueueEvents)
    expect(txHash.length).eq(66)

    const sentJob = (await sentTxQueue.getJob(sentId)) as Job
    const [status, sentHash] = await sentJob.waitUntilFinished(sentQueueEvents)
    expect(status).eq(SentTxState.MINED)
    expect(txHash).not.eq(sentHash)

    const r = await web3.eth.getTransactionReceipt(sentHash)
    expect(r.status).eq(true)
  })

  it('should re-submit optimistic txs after revert', async () => {
    await poolWorker.pause()

    // @ts-ignore
    const deposit = flow[2] as PermitDepositOutputItem
    await mintTokens(deposit.txTypeData.from as string, parseInt(deposit.txTypeData.amount))
    await sentWorker.pause()

    const mockPoolWorker = await createPoolTxWorker(gasPriceService, async () => {}, workerMutex, newConnection())
    mockPoolWorker.run()
    await mockPoolWorker.waitUntilReady()

    // Incorrect signature
    const wrongDeposit = {
      ...deposit,
      depositSignature:
        'ac7c17093f92ed1047c9c2a68506639abe8c5751ac8172622902cd07f0f87b3b78ea22626cb18f8ee4420f2e74414507c692fa15cc816f610a3adaaa6ef591cf',
    }
    // @ts-ignore
    const poolJob1 = await submitJob(wrongDeposit)
    const poolJob2 = await submitJob(deposit)

    const [[, sentId1]] = await poolJob1.waitUntilFinished(poolQueueEvents)
    const [[, sentId2]] = await poolJob2.waitUntilFinished(poolQueueEvents)

    sentWorker.resume()
    const sentJob1 = (await sentTxQueue.getJob(sentId1)) as Job
    const [status1, , rescheduledIds1] = await sentJob1.waitUntilFinished(sentQueueEvents)
    expect(status1).eq(SentTxState.REVERT)
    // Second failed tx should be rescheduled
    expect(rescheduledIds1.length).eq(1)

    const sentJob2 = (await sentTxQueue.getJob(sentId2)) as Job
    const [status2, , rescheduledIds2] = await sentJob2.waitUntilFinished(sentQueueEvents)
    expect(status2).eq(SentTxState.REVERT)
    expect(rescheduledIds2.length).eq(0)

    const poolJob3 = (await poolTxQueue.getJob(rescheduledIds1[0])) as Job
    const [[, sentId3]] = await poolJob3.waitUntilFinished(poolQueueEvents)

    const sentJob3 = (await sentTxQueue.getJob(sentId3)) as Job
    const [status3, sentHash] = await sentJob3.waitUntilFinished(sentQueueEvents)
    expect(status3).eq(SentTxState.MINED)

    const r = await web3.eth.getTransactionReceipt(sentHash)
    expect(r.status).eq(true)

    expect(await poolTxQueue.count()).eq(0)
    expect(await sentTxQueue.count()).eq(0)

    // Restore main worker
    await mockPoolWorker.close()
    poolWorker.resume()
    await poolWorker.waitUntilReady()
  })

  it('should reject txs when maxSentQueueSize is reached', async () => {
    const maxSentQueueSize = config.maxSentQueueSize
    config.maxSentQueueSize = 0

    const deposit = flow[0]
    // @ts-ignore
    const job = await submitJob(deposit)
    await expect(job.waitUntilFinished(poolQueueEvents)).to.be.rejectedWith('Optimistic state overflow')

    config.maxSentQueueSize = maxSentQueueSize
  })

  it('should reject if proof incorrect', async () => {
    const deposit = flowDependentDeposits[1]
    await mintTokens(deposit.txTypeData.from as string, parseInt(deposit.txTypeData.amount))

    // @ts-ignore
    const job = await submitJob(deposit)

    await expect(job.waitUntilFinished(poolQueueEvents)).rejectedWith('Incorrect root at index')
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
