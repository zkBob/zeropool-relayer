import chai from 'chai'
import type BN from 'bn.js'
import { toBN } from 'web3-utils'
import { v4 } from 'uuid'
import { Mutex } from 'async-mutex'
import chaiAsPromised from 'chai-as-promised'
import { Job, QueueEvents, Worker } from 'bullmq'
import { TxType } from 'zp-memo-parser'
import { web3 } from './web3'
import { pool } from '../../pool'
import config from '../../configs/relayerConfig'
import DirectDepositQueueAbi from '../../abi/direct-deposit-queue-abi.json'
import { sentTxQueue, SentTxState } from '../../queue/sentTxQueue'
import { poolTxQueue, PoolTxResult, BatchTx, WorkerTxType, DirectDeposit } from '../../queue/poolTxQueue'
import { createPoolTxWorker } from '../../workers/poolTxWorker'
import { createSentTxWorker } from '../../workers/sentTxWorker'
import { PoolState } from '../../state/PoolState'
import { EstimationType, GasPrice } from '../../services/gas-price'
import { redis } from '../../services/redisClient'
import { initializeDomain } from '../../utils/EIP712SaltedPermit'
import { FlowOutputItem } from '../../../test-flow-generator/src/types'
import {
  approveTokens,
  disableMining,
  enableMining,
  evmRevert,
  evmSnapshot,
  mintTokens,
  newConnection,
  setBalance,
} from './utils'
import { validateTx } from '../../validation/tx/validateTx'
import { TxManager } from '../../tx/TxManager'
import { Circuit, IProver, LocalProver } from '../../prover/'

import flow from '../flows/flow_independent_deposits_5.json'
import flowDependentDeposits from '../flows/flow_dependent_deposits_2.json'
import flowZeroAddressWithdraw from '../flows/flow_zero-address_withdraw_2.json'
import { Params } from 'libzkbob-rs-node'
import { directDepositQueue } from '../../queue/directDepositQueue'
import { createDirectDepositWorker } from '../../workers/directDepositWorker'
import { FeeManager, DefaultFeeManager } from '../../services/fee'

chai.use(chaiAsPromised)
const expect = chai.expect

async function submitJob(item: FlowOutputItem<TxType>): Promise<Job<BatchTx<WorkerTxType>, PoolTxResult[]>> {
  const job = await poolTxQueue.add('test', {
    type: WorkerTxType.Normal,
    transactions: [
      {
        amount: '0',
        txProof: item.proof,
        txType: item.txType,
        rawMemo: item.transactionData.memo,
        depositSignature: item.depositSignature,
      },
    ],
    traceId: 'test',
  })
  return job
}

async function submitDirectDepositJob(deposits: DirectDeposit[]) {
  const job = await directDepositQueue.add('test', deposits)
  return job
}

describe('poolWorker', () => {
  let poolWorker: Worker
  let sentWorker: Worker
  let gasPriceService: GasPrice<EstimationType.Web3>
  let txManager: TxManager
  let feeManager: FeeManager
  let poolQueueEvents: QueueEvents
  let sentQueueEvents: QueueEvents
  let directDepositQueueEvents: QueueEvents
  let mutex: Mutex
  let snapShotId: string
  let eventsInit = false
  let treeProver: IProver<Circuit.Tree>
  const treeParams = Params.fromFile(config.treeUpdateParamsPath as string, true)
  const directDepositParams = Params.fromFile(config.directDepositParamsPath as string, true)
  const ddSender = '0x28a8746e75304c0780e011bed21c72cd78cd535e'

  beforeEach(async () => {
    snapShotId = await evmSnapshot()

    const id = v4()
    const statesPath = `${config.stateDirPath}${id}`
    const poolState = new PoolState(`pool-${id}`, redis, statesPath)
    const optimisticState = new PoolState(`optimistic-${id}`, redis, statesPath)
    pool.loadState({ poolState, optimisticState })

    await pool.init()
    await initializeDomain(web3)

    gasPriceService = new GasPrice(web3, { gasPrice: config.gasPriceFallback }, 10000, EstimationType.Web3, {})
    await gasPriceService.start()

    const mockPriceFeed = {
      convert: (amounts: BN[]) => Promise.resolve(amounts.map(() => toBN(0))),
    }
    const managerConfig = {
      gasPrice: gasPriceService,
      priceFeed: mockPriceFeed,
      scaleFactor: toBN(1),
      marginFactor: toBN(1),
    }
    feeManager = new DefaultFeeManager(managerConfig)
    await feeManager.init()

    txManager = new TxManager(web3, config.relayerPrivateKey, gasPriceService)
    await txManager.init()

    mutex = new Mutex()

    treeProver = new LocalProver(Circuit.Tree, treeParams)
    const directDepositProver = new LocalProver(Circuit.DirectDeposit, directDepositParams)

    const baseConfig = {
      redis,
    }
    poolWorker = await createPoolTxWorker({
      ...baseConfig,
      validateTx,
      treeProver,
      mutex,
      txManager,
      feeManager,
    })
    sentWorker = await createSentTxWorker({
      ...baseConfig,
      mutex,
      txManager,
    })
    const directDepositWorker = await createDirectDepositWorker({
      ...baseConfig,
      directDepositProver,
    })
    sentWorker.run()
    poolWorker.run()
    directDepositWorker.run()

    if (!eventsInit) {
      poolQueueEvents = new QueueEvents(poolWorker.name, { connection: redis })
      sentQueueEvents = new QueueEvents(sentWorker.name, { connection: redis })
      directDepositQueueEvents = new QueueEvents(directDepositWorker.name, { connection: redis })
      eventsInit = true
    }

    await poolWorker.waitUntilReady()
    await sentWorker.waitUntilReady()
    await directDepositWorker.waitUntilReady()
    await enableMining()
  })

  afterEach(async () => {
    await evmRevert(snapShotId)

    await sentTxQueue.drain(true)
    await poolTxQueue.drain(true)

    await poolWorker.close()
    await sentWorker.close()

    await pool.state.jobIdsMapping.clear()

    gasPriceService.stop()
  })

  async function expectJobFinished(job: Job<BatchTx<WorkerTxType>, PoolTxResult[]>) {
    const [[initialHash, sentId]] = await job.waitUntilFinished(poolQueueEvents)
    expect(initialHash.length).eq(66)

    const sentJob = (await sentTxQueue.getJob(sentId)) as Job
    const [status, sentHash] = await sentJob.waitUntilFinished(sentQueueEvents)
    expect(status).eq(SentTxState.MINED)

    const r = await web3.eth.getTransactionReceipt(sentHash)
    expect(r.status).eq(true)

    return {
      initialHash,
      sentHash,
    }
  }

  it('executes a job', async () => {
    const deposit = flow[0]
    await mintTokens(deposit.txTypeData.from as string, parseInt(deposit.txTypeData.amount))

    // @ts-ignore
    const job = await submitJob(deposit)
    const { initialHash, sentHash } = await expectJobFinished(job)
    expect(initialHash).eq(sentHash)
  })

  it('should re-submit optimistic txs after revert', async () => {
    await poolWorker.pause()

    const deposit = flow[0]
    await mintTokens(deposit.txTypeData.from as string, parseInt(deposit.txTypeData.amount))
    await sentWorker.pause()

    const mockPoolWorker = await createPoolTxWorker({
      mutex,
      redis: newConnection(),
      txManager,
      validateTx: async () => {},
      treeProver,
      feeManager,
    })
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
    // @ts-ignore
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
    expect(await pool.state.jobIdsMapping.get(poolJob2.id as string)).eq(poolJob3.id)

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

  it('should increase gas price on re-send', async () => {
    const deposit = flow[0]
    await mintTokens(deposit.txTypeData.from as string, parseInt(deposit.txTypeData.amount))
    await disableMining()

    // @ts-ignore
    const job = await submitJob(deposit)

    const [[txHash, sentId]] = await job.waitUntilFinished(poolQueueEvents)

    const txBefore = await web3.eth.getTransaction(txHash)
    const gasPriceBefore = Number(txBefore.gasPrice)

    sentWorker.on('progress', async () => {
      await enableMining()
    })

    const sentJob = (await sentTxQueue.getJob(sentId)) as Job
    const [status, sentHash] = await sentJob.waitUntilFinished(sentQueueEvents)
    expect(status).eq(SentTxState.MINED)
    expect(txHash).not.eq(sentHash)

    const txAfter = await web3.eth.getTransaction(sentHash)
    const gasPriceAfter = Number(txAfter.gasPrice)

    expect(gasPriceBefore).lt(gasPriceAfter)
  })

  it('should reject withdrawal to zero address', async () => {
    const [deposit, withdraw] = flowZeroAddressWithdraw

    await mintTokens(deposit.txTypeData.from as string, parseInt(deposit.txTypeData.amount))

    // @ts-ignore
    const job = await submitJob(deposit)
    await expectJobFinished(job)

    // @ts-ignore
    const withdrawJob = await submitJob(withdraw)
    await expect(withdrawJob.waitUntilFinished(poolQueueEvents)).rejectedWith('Withdraw address cannot be zero')
  })

  it('should pause queues when relayer has insufficient funds', async () => {
    let deposit = flow[0]
    await mintTokens(deposit.txTypeData.from as string, parseInt(deposit.txTypeData.amount))
    const oldBalance = await web3.eth.getBalance(config.relayerAddress)

    await setBalance(config.relayerAddress, '0x0')

    // @ts-ignore
    const job = await submitJob(deposit)
    await job.waitUntilFinished(poolQueueEvents)

    expect(await poolTxQueue.count()).eq(0)
    expect(await sentTxQueue.count()).eq(1)
    expect(await poolTxQueue.isPaused()).eq(true)
    expect(await sentTxQueue.isPaused()).eq(true)

    await setBalance(config.relayerAddress, oldBalance)

    await expectJobFinished(job)
  })

  it('should process direct deposit transaction', async () => {
    const queueAddress = await pool.PoolInstance.methods.direct_deposit_queue().call()
    const DirectDepositQueueInstance = new web3.eth.Contract(DirectDepositQueueAbi as any, queueAddress)

    const fee = await DirectDepositQueueInstance.methods.directDepositFee().call()
    const numDeposits = 16
    const singleDepositAmount = 2
    const amount = toBN(fee).muln(numDeposits * singleDepositAmount)

    await mintTokens(ddSender, amount)
    await approveTokens(ddSender, queueAddress, amount)

    const zkAddress = 'QsnTijXekjRm9hKcq5kLNPsa6P4HtMRrc3RxVx3jsLHeo2AiysYxVJP86mriHfN'
    for (let i = 0; i < numDeposits; i++) {
      await DirectDepositQueueInstance.methods
        .directDeposit(ddSender, pool.denominator.mul(toBN(fee).muln(singleDepositAmount)), zkAddress)
        .send({ from: ddSender })
    }

    const events = await DirectDepositQueueInstance.getPastEvents('SubmitDirectDeposit', {
      fromBlock: 0,
      toBlock: 'latest',
    })
    const dds: DirectDeposit[] = events.map(e => {
      const dd = e.returnValues
      return {
        sender: dd.sender,
        nonce: dd.nonce,
        fallbackUser: dd.fallbackUser,
        zkAddress: {
          diversifier: dd.zkAddress.diversifier,
          pk: dd.zkAddress.pk,
        },
        deposit: dd.deposit,
      }
    })
    const ddJob = await submitDirectDepositJob(dds)
    const [poolJobId, memo] = await ddJob.waitUntilFinished(directDepositQueueEvents)
    const poolJob = (await poolTxQueue.getJob(poolJobId)) as Job
    await expectJobFinished(poolJob)

    const contractMemo: string = (
      await pool.PoolInstance.getPastEvents('Message', {
        fromBlock: 0,
        toBlock: 'latest',
      })
    ).map(e => e.returnValues.message)[0]

    expect(memo).eq(contractMemo.slice(2))
  })
})
