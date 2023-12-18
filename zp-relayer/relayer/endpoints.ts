import type { Queue } from 'bullmq'
import { Request, Response } from 'express'
import type { LimitsFetch, Pool, PoolTx } from '../pool'
import { JobState, PoolTx as Tx, WorkerTxType, poolTxQueue } from '../queue/poolTxQueue'
import config from '../configs/relayerConfig'
import {
  validateCountryIP,
  checkGetLimits,
  checkGetSiblings,
  checkGetTransactionsV2,
  checkMerkleRootErrors,
  checkSendTransactionsErrors,
  checkTraceId,
  validateBatch,
  ValidationFunction,
} from '../validation/api/validation'
import { HEADER_TRACE_ID } from '../utils/constants'
import type { FeeManager } from '../services/fee'

interface PoolInjection {
  pool: Pool
}

interface FeeManagerInjection {
  feeManager: FeeManager
}

interface HashInjection {
  hash: string | null
}

const checkTraceIdFromConfig: ValidationFunction = (() => {
  if (config.RELAYER_REQUIRE_TRACE_ID) {
    return checkTraceId
  }
  return () => null
})()

async function sendTransactions(req: Request, res: Response, { pool }: PoolInjection) {
  validateBatch([
    [checkTraceIdFromConfig, req.headers],
    [checkSendTransactionsErrors, req.body],
  ])

  await validateCountryIP(req.ip, config.RELAYER_BLOCKED_COUNTRIES)

  const rawTxs = req.body as PoolTx[]
  const traceId = req.headers[HEADER_TRACE_ID] as string

  const txs = rawTxs.map(tx => {
    const { proof, memo, txType, depositSignature } = tx
    return {
      proof,
      memo,
      txType,
      depositSignature,
    }
  })
  if (txs.length !== 1) {
    throw new Error('Batch transactions are not supported')
  }
  const jobId = await pool.transact(txs[0], traceId)
  res.json({ jobId })
}

async function merkleRoot(req: Request, res: Response, { pool }: PoolInjection) {
  validateBatch([
    [checkTraceIdFromConfig, req.headers],
    [checkMerkleRootErrors, req.params],
  ])

  const index = req.params.index
  const root = await pool.getContractMerkleRoot(index)
  res.json(root)
}

async function getTransactionsV2(req: Request, res: Response, { pool }: PoolInjection) {
  validateBatch([
    [checkTraceIdFromConfig, req.headers],
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

async function getJob(req: Request, res: Response, { pool }: PoolInjection) {
  interface GetJobResponse {
    resolvedJobId: string
    createdOn: number
    failedReason: null | string
    finishedOn: null | number
    state: JobState
    txHash: null | string
  }

  validateBatch([[checkTraceIdFromConfig, req.headers]])

  const jobId = req.params.id

  async function getPoolJobState(requestedJobId: string): Promise<GetJobResponse | null> {
    const INCONSISTENCY_ERR = 'Internal job inconsistency'

    // Should be used in places where job is expected to exist
    const safeGetJob = async (queue: Queue<Tx<WorkerTxType>>, id: string) => {
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
      state: JobState.WAITING,
      txHash: null,
    }

    if (poolJobState === 'completed') {
      // Transaction was included in optimistic state, waiting to be mined

      // Sanity check
      // if (job.returnvalue === null) throw new Error(INCONSISTENCY_ERR)
      result.state = job.data.transaction.state
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

function relayerInfo(req: Request, res: Response, { pool }: PoolInjection) {
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

async function getFee(req: Request, res: Response, { pool, feeManager }: PoolInjection & FeeManagerInjection) {
  validateBatch([[checkTraceIdFromConfig, req.headers]])

  const feeOptions = await feeManager.getFeeOptions()
  const fees = feeOptions.denominate(pool.denominator).getObject()

  res.json(fees)
}

async function getLimits(req: Request, res: Response, { pool }: PoolInjection) {
  validateBatch([
    [checkTraceIdFromConfig, req.headers],
    [checkGetLimits, req.query],
  ])

  const address = req.query.address as unknown as string

  let limitsFetch: LimitsFetch
  try {
    const limits = await pool.getLimitsFor(address)
    limitsFetch = pool.processLimits(limits)
  } catch (e) {
    throw new Error(`Error while fetching limits for ${address}`)
  }

  res.json(limitsFetch)
}

function getMaxNativeAmount(req: Request, res: Response) {
  validateBatch([[checkTraceIdFromConfig, req.headers]])

  res.json({
    maxNativeAmount: config.RELAYER_MAX_NATIVE_AMOUNT.toString(10),
  })
}

function getSiblings(req: Request, res: Response, { pool }: PoolInjection) {
  validateBatch([
    [checkTraceIdFromConfig, req.headers],
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

function getParamsHash(req: Request, res: Response, { hash }: HashInjection) {
  res.json({ hash })
}

function relayerVersion(req: Request, res: Response) {
  res.json({
    ref: config.RELAYER_REF,
    commitHash: config.RELAYER_SHA,
  })
}

function root(req: Request, res: Response) {
  return res.sendStatus(200)
}

export function inject<T>(values: T, f: (req: Request, res: Response, e: T) => void) {
  return (req: Request, res: Response) => {
    return f(req, res, values)
  }
}

export default {
  sendTransactions,
  merkleRoot,
  getTransactionsV2,
  getJob,
  relayerInfo,
  getFee,
  getLimits,
  getMaxNativeAmount,
  getSiblings,
  getParamsHash,
  relayerVersion,
  root,
  inject,
}
