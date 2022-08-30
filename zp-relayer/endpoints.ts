import fs from 'fs'
import { Request, Response, NextFunction } from 'express'
import { pool } from './pool'
import { logger } from './services/appLogger'
import { poolTxQueue } from './queue/poolTxQueue'
import config from './config'
import { proveTx } from './prover'
import {
  checkGetTransactions,
  checkGetTransactionsV2,
  checkSendTransactionErrors,
  checkSendTransactionsErrors,
} from './validation/validation'

const txProof = (() => {
  let txProofNum = 0
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      logger.debug('Proving tx...')
      const { pub, sec } = req.body
      if (logger.isDebugEnabled()) {
        const TX_PROOFS_DIR = 'tx_proofs'
        if (!fs.existsSync(TX_PROOFS_DIR)) {
          fs.mkdirSync(TX_PROOFS_DIR, { recursive: true })
        }
        fs.writeFileSync(`${TX_PROOFS_DIR}/object${txProofNum}.json`, JSON.stringify([pub, sec], null, 2))
        txProofNum += 1
      }
      const proof = await proveTx(pub, sec)
      logger.debug('Tx proved')
      res.json(proof)
    } catch (err) {
      next(err)
    }
  }
})()

async function sendTransactions(req: Request, res: Response, next: NextFunction) {
  const errors = checkSendTransactionsErrors(req.body)
  if (errors) {
    logger.info('Request errors: %o', errors)
    res.status(400).json({ errors })
    return
  }

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
  const errors = checkSendTransactionErrors(req.body)
  if (errors) {
    logger.info('Request errors: %o', errors)
    res.status(400).json({ errors })
    return
  }

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
  const errors = checkGetTransactions(req.query)
  if (errors) {
    logger.info('Request errors: %o', errors)
    res.status(400).json({ errors })
    return
  }

  const state = req.query.optimistic ? pool.optimisticState : pool.state
  // Types checked in validation stage
  // @ts-ignore
  const { txs } = await state.getTransactions(req.query.limit, req.query.offset)
  res.json(txs)
}

async function getTransactionsV2(req: Request, res: Response, next: NextFunction) {
  const errors = checkGetTransactionsV2(req.query)
  if (errors) {
    logger.info('Request errors: %o', errors)
    res.status(400).json({ errors })
    return
  }

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
  const jobId = req.params.id
  const job = await poolTxQueue.getJob(jobId)
  if (job) {
    const state = await job.getState()
    const txHash = job.returnvalue
    const failedReason = job.failedReason
    const createdOn = job.timestamp
    const finishedOn = job.finishedOn

    res.json({
      state,
      txHash,
      failedReason,
      createdOn,
      finishedOn,
    })
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

export default {
  txProof,
  sendTransaction,
  sendTransactions,
  merkleRoot,
  getTransactions,
  getTransactionsV2,
  getJob,
  relayerInfo,
  getFee,
}
