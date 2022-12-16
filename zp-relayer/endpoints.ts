import { Request, Response, NextFunction } from 'express'
import { pool } from './pool'
import { poolTxQueue } from './queue/poolTxQueue'
import config from './config'
import { sentTxQueue, SentTxState } from './queue/sentTxQueue'

async function sendTransactions(req: Request, res: Response, next: NextFunction) {
  const rawTxs = req.body
  const txs = rawTxs.map((tx: any) => {
    const { proof, memo, txType, depositSignature } = tx
    return {
      proof,
      memo,
      txType,
      depositSignature,
    }
  })
  const jobId = await pool.transact(txs)
  res.json({ jobId })
}

async function sendTransaction(req: Request, res: Response, next: NextFunction) {
  const { proof, memo, txType, depositSignature } = req.body
  const tx = [{ proof, memo, txType, depositSignature }]
  const jobId = await pool.transact(tx)
  res.json({ jobId })
}

async function merkleRoot(req: Request, res: Response, next: NextFunction) {
  const index = req.params.index
  const root = await pool.getContractMerkleRoot(index)
  res.json(root)
}

async function getTransactions(req: Request, res: Response, next: NextFunction) {
  const state = req.query.optimistic ? pool.optimisticState : pool.state
  // Types checked in validation stage
  // @ts-ignore
  const { txs } = await state.getTransactions(req.query.limit, req.query.offset)
  res.json(txs)
}

async function getTransactionsV2(req: Request, res: Response, next: NextFunction) {
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

  const jobId = req.params.id

  async function getPoolJobState(requestedJobId: string): Promise<GetJobResponse | null> {
    const jobId = await pool.state.jobIdsMapping.get(requestedJobId)
    let job = await poolTxQueue.getJob(jobId)
    if (!job) return null

    // Default result object
    let result: GetJobResponse = {
      resolvedJobId: jobId,
      createdOn: job.timestamp,
      failedReason: null,
      finishedOn: null,
      state: JobStatus.WAITING,
      txHash: null,
    }

    const poolJobState = await job.getState()
    if (poolJobState === 'completed') {
      // Transaction was included in optimistic state, waiting to be mined
      if (job.returnvalue === null) {
        job = await poolTxQueue.getJob(jobId)
        // Sanity check
        if (!job || job.returnvalue === null) throw new Error('Internal job inconsistency')
      }
      const sentJobId = job.returnvalue[0][1]
      let sentJob = await sentTxQueue.getJob(sentJobId)
      // Should not happen here, but need to verify to be sure
      if (!sentJob) throw new Error('Sent job not found')

      const sentJobState = await sentJob.getState()
      if (sentJobState === 'waiting' || sentJobState === 'active' || sentJobState === 'delayed') {
        // Transaction is in re-send loop
        const txHash = sentJob.data.prevAttempts.at(-1)?.[0]
        result.state = JobStatus.SENT
        result.txHash = txHash || null
      } else if (sentJobState === 'completed') {
        if (sentJob.returnvalue === null) {
          sentJob = await sentTxQueue.getJob(sentJobId)
          // Sanity check
          if (!sentJob || sentJob.returnvalue === null) throw new Error('Internal job inconsistency')
        }
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
      // Either validation or tx sendind failed
      if (!job.finishedOn) {
        job = await poolTxQueue.getJob(jobId)
        // Sanity check
        if (!job || !job.finishedOn) throw new Error('Internal job inconsistency')
      }
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
  res.json({
    fee: config.relayerFee.toString(10),
  })
}

async function getLimits(req: Request, res: Response) {
  const address = req.query.address as unknown as string
  const limits = await pool.getLimitsFor(address)
  const limitsFetch = pool.processLimits(limits)
  res.json(limitsFetch)
}

function getParamsHash(type: 'tree' | 'transfer') {
  const hash = type === 'tree' ? pool.treeParamsHash : pool.transferParamsHash
  return (req: Request, res: Response) => {
    res.json({ hash })
  }
}

function root(req: Request, res: Response) {
  return res.sendStatus(200)
}

export default {
  sendTransaction,
  sendTransactions,
  merkleRoot,
  getTransactions,
  getTransactionsV2,
  getJob,
  relayerInfo,
  getFee,
  getLimits,
  getParamsHash,
  root,
}
