import { Request, Response } from 'express'
import { pool, PoolTx } from './pool'
import { poolTxQueue } from './queue/poolTxQueue'
import config from './configs/relayerConfig'
import {
  checkGetLimits,
  checkGetSiblings,
  checkGetTransactionsV2,
  checkMerkleRootErrors,
  checkSendTransactionsErrors,
  checkTraceId,
  validateBatch,
} from './validation/validation'
import { sentTxQueue, SentTxState } from './queue/sentTxQueue'
import type { Queue } from 'bullmq'
import { TRACE_ID } from './utils/constants'

async function sendTransactions(req: Request, res: Response) {
  validateBatch([
    [checkTraceId, req.headers],
    [checkSendTransactionsErrors, req.body],
  ])

  const rawTxs = req.body as PoolTx[]
  const traceId = req.headers[TRACE_ID] as string

  const txs = rawTxs.map(tx => {
    const { proof, memo, txType, depositSignature } = tx
    return {
      proof,
      memo,
      txType,
      depositSignature,
    }
  })
  const jobId = await pool.transact(txs, traceId)
  res.json({ jobId })
}

async function merkleRoot(req: Request, res: Response) {
  validateBatch([
    [checkTraceId, req.headers],
    [checkMerkleRootErrors, req.params],
  ])

  const index = req.params.index
  const root = await pool.getContractMerkleRoot(index)
  res.json(root)
}

async function getTransactionsV2(req: Request, res: Response) {
  validateBatch([
    [checkTraceId, req.headers],
    [checkGetTransactionsV2, req.query],
  ])

  const toV2Format = (prefix: string) => (tx: string) => {
    const outCommit = tx.slice(0, 64)
    const txHash = tx.slice(64, 128)
    const memo = tx.slice(128)
    return prefix + txHash + outCommit + memo
  }

  // Types checked in validation stage
  const limit = req.query.limit as unknown as number
  const offset = req.query.offset as unknown as number

  const txs: string[] = []
  const { txs: poolTxs, nextOffset } = await pool.state.getTransactions(limit, offset)
  txs.push(...poolTxs.map(toV2Format('1')))

  if (txs.length < limit) {
    const { txs: optimisticTxs } = await pool.optimisticState.getTransactions(limit - txs.length, nextOffset)
    txs.push(...optimisticTxs.map(toV2Format('0')))
  }

  res.json(txs)
}

async function getJob(req: Request, res: Response) {
  enum JobStatus {
    WAITING = 'waiting',
    FAILED = 'failed',
    SENT = 'sent',
    REVERTED = 'reverted',
    COMPLETED = 'completed',
  }

  interface GetJobResponse {
    resolvedJobId: string
    createdOn: number
    failedReason: null | string
    finishedOn: null | number
    state: JobStatus
    txHash: null | string
  }

  validateBatch([[checkTraceId, req.headers]])

  const jobId = req.params.id

  async function getPoolJobState(requestedJobId: string): Promise<GetJobResponse | null> {
    const INCONSISTENCY_ERR = 'Internal job inconsistency'

    // Should be used in places where job is expected to exist
    const safeGetJob = async (queue: Queue, id: string) => {
      const job = await queue.getJob(id)
      if (!job) {
        throw new Error(INCONSISTENCY_ERR)
      }
      return job
    }

    const jobId = await pool.state.jobIdsMapping.get(requestedJobId)

    const poolJobState = await poolTxQueue.getJobState(jobId)
    if (poolJobState === 'unknown') return null

    const job = await safeGetJob(poolTxQueue, jobId)

    // Default result object
    let result: GetJobResponse = {
      resolvedJobId: jobId,
      createdOn: job.timestamp,
      failedReason: null,
      finishedOn: null,
      state: JobStatus.WAITING,
      txHash: null,
    }

    if (poolJobState === 'completed') {
      // Transaction was included in optimistic state, waiting to be mined

      // Sanity check
      if (job.returnvalue === null) throw new Error(INCONSISTENCY_ERR)
      const sentJobId = job.returnvalue[0][1]

      const sentJobState = await sentTxQueue.getJobState(sentJobId)
      // Should not happen here, but need to verify to be sure
      if (sentJobState === 'unknown') throw new Error('Sent job not found')

      const sentJob = await safeGetJob(sentTxQueue, sentJobId)
      if (sentJobState === 'waiting' || sentJobState === 'active' || sentJobState === 'delayed') {
        // Transaction is in re-send loop
        const txHash = sentJob.data.prevAttempts.at(-1)?.[0]
        result.state = JobStatus.SENT
        result.txHash = txHash || null
      } else if (sentJobState === 'completed') {
        // Sanity check
        if (sentJob.returnvalue === null) throw new Error(INCONSISTENCY_ERR)

        const [txState, txHash] = sentJob.returnvalue
        if (txState === SentTxState.MINED) {
          // Transaction mined successfully
          result.state = JobStatus.COMPLETED
          result.txHash = txHash
          result.finishedOn = sentJob.finishedOn || null
        } else if (txState === SentTxState.REVERT) {
          // Transaction reverted
          result.state = JobStatus.REVERTED
          result.txHash = txHash
          result.finishedOn = sentJob.finishedOn || null
        }
      }
    } else if (poolJobState === 'failed') {
      // Either validation or tx sending failed

      // Sanity check
      if (!job.finishedOn) throw new Error(INCONSISTENCY_ERR)

      result.state = JobStatus.FAILED
      result.failedReason = job.failedReason
      result.finishedOn = job.finishedOn || null
    }
    // Other states mean that transaction is either waiting in queue
    // or being processed by worker
    // So, no need to update `result` object

    return result
  }

  const jobState = await getPoolJobState(jobId)
  if (jobState) {
    res.json(jobState)
  } else {
    res.json(`Job ${jobId} not found`)
  }
}

function relayerInfo(req: Request, res: Response) {
  const deltaIndex = pool.state.getNextIndex()
  const optimisticDeltaIndex = pool.optimisticState.getNextIndex()
  const root = pool.state.getMerkleRoot()
  const optimisticRoot = pool.optimisticState.getMerkleRoot()

  res.json({
    root,
    optimisticRoot,
    deltaIndex,
    optimisticDeltaIndex,
  })
}

function getFee(req: Request, res: Response) {
  validateBatch([[checkTraceId, req.headers]])

  res.json({
    fee: config.relayerFee.toString(10),
  })
}

async function getLimits(req: Request, res: Response) {
  validateBatch([
    [checkTraceId, req.headers],
    [checkGetLimits, req.query],
  ])

  const address = req.query.address as unknown as string
  const limits = await pool.getLimitsFor(address)
  const limitsFetch = pool.processLimits(limits)
  res.json(limitsFetch)
}

function getSiblings(req: Request, res: Response) {
  validateBatch([
    [checkTraceId, req.headers],
    [checkGetSiblings, req.query],
  ])

  const index = req.query.index as unknown as number

  if (index >= pool.state.getNextIndex()) {
    res.status(400).json({ errors: ['Index out of range'] })
    return
  }

  const siblings = pool.state.getSiblings(index)
  res.json(siblings)
}

function getParamsHash(type: 'tree' | 'transfer') {
  const hash = type === 'tree' ? pool.treeParamsHash : pool.transferParamsHash
  return (req: Request, res: Response) => {
    res.json({ hash })
  }
}

function relayerVersion(req: Request, res: Response) {
  res.json({
    ref: config.relayerRef,
    commitHash: config.relayerSHA,
  })
}

function root(req: Request, res: Response) {
  return res.sendStatus(200)
}

export default {
  sendTransactions,
  merkleRoot,
  getTransactionsV2,
  getJob,
  relayerInfo,
  getFee,
  getLimits,
  getSiblings,
  getParamsHash,
  relayerVersion,
  root,
}
