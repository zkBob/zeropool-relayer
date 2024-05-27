import { logger } from '@/lib/appLogger'
import type { BasePool } from '@/pool/BasePool'
import { RelayPool } from '@/pool/RelayPool'
import { LimitsFetch } from '@/pool/types'
import { txToV2Format } from '@/utils/helpers'
import type { Queue } from 'bullmq'
import { Request, Response } from 'express'
import config from '../../configs/relayerConfig'
import type { FeeManager } from '../../lib/fee'
import { BasePoolTx, JobState, PoolTx as Tx, poolTxQueue, WorkerTxType } from '../../queue/poolTxQueue'
import { HEADER_TRACE_ID, OUTPLUSONE } from '../../utils/constants'
import {
  checkGetLimits,
  checkGetSiblings,
  checkGetTransactionsV2,
  checkMerkleRootErrors,
  checkSendTransactionsErrors,
  checkTraceId,
  validateBatch,
  validateCountryIP,
  ValidationFunction,
} from '../../validation/api/validation'

interface PoolInjection {
  pool: BasePool
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

  const rawTxs = req.body as BasePoolTx[]
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

  // Types checked in validation stage
  const limit = req.query.limit as unknown as number
  const offset = req.query.offset as unknown as number
  const url = new URL('/transactions/v2', config.base.COMMON_INDEXER_URL)
  url.searchParams.set('limit', limit.toString())
  url.searchParams.set('offset', offset.toString())

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch transactions from indexer. Status: ${res.status}`)
  }
  const indexerTxs: string[] = await response.json()
  
  const lastIndex = offset + indexerTxs.length * OUTPLUSONE
  const txStore = (pool as RelayPool).txStore
  const indices = await txStore.getAll().then(keys => {
    return Object.entries(keys)
      .map(([i, v]) => [parseInt(i), v] as [number, string])
      .filter(([i]) => offset <= i && i <= lastIndex)
      .sort(([i1], [i2]) => i1 - i2)
  })

  const indexerCommitments = indexerTxs.map(tx => tx.slice(65, 129));
  const optimisticTxs: string[] = []
  for (const [index, memo] of indices) {
    const commitLocal = memo.slice(0, 64)
    if (indexerCommitments.includes(commitLocal)) {
      logger.info('Deleting index from optimistic state', { index })
      await txStore.remove(index.toString())
    } else {
      optimisticTxs.push(txToV2Format('0', memo))
    }
  }

  const txs: string[] = [...indexerTxs, ...optimisticTxs]

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
    const { txHash, state } = job.data.transaction

    // Default result object
    let result: GetJobResponse = {
      resolvedJobId: jobId,
      createdOn: job.timestamp,
      failedReason: job.failedReason,
      finishedOn: null,
      state,
      txHash,
    }

    return result
  }

  const jobState = await getPoolJobState(jobId)
  if (jobState) {
    res.json(jobState)
  } else {
    res.json(`Job ${jobId} not found`)
  }
}

async function relayerInfo(req: Request, res: Response, { pool }: PoolInjection) {
  const url = new URL('/info', config.base.COMMON_INDEXER_URL)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch info from indexer. Status: ${res.status}`)
  }
  const info = await response.json()

  res.json(info)
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

async function getProverFee(req: Request, res: Response) {
  const url = new URL('/fee', config.RELAYER_PROVER_URL)
  const fee = await fetch(url.toString()).then(r => r.json())
  res.json(fee)
}

async function getProverAddress(req: Request, res: Response) {
  const url = new URL('/address', config.RELAYER_PROVER_URL)
  const address = await fetch(url.toString()).then(r => r.json())
  res.json(address)
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
  getMaxNativeAmount,
  getSiblings,
  getParamsHash,
  getProverFee,
  getProverAddress,
  relayerVersion,
  root,
}
