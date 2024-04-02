import { logger } from '@/lib/appLogger'
import { BasePool } from '@/pool/BasePool'
import { inject } from '@/utils/helpers'
import { checkGetTransactionsV2, validateBatch } from '@/validation/api/validation'
import cors from 'cors'
import express, { NextFunction, Request, Response } from 'express'

function wrapErr(f: (_req: Request, _res: Response, _next: NextFunction) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await f(req, res, next)
    } catch (e) {
      next(e)
    }
  }
}

interface RouterConfig {
  pool: BasePool
}

export function createRouter({ pool }: RouterConfig) {
  const router = express.Router()

  router.use(cors())
  router.use(express.urlencoded({ extended: true }))
  router.use(express.json())
  router.use(express.text())

  router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err) {
      logger.error('Request error:', err)
      return res.sendStatus(500)
    }
    next()
  })

  router.get('/transactions/v2', wrapErr(inject({ pool }, getTransactionsV2)))
  router.get('/info', wrapErr(inject({ pool }, relayerInfo)))

  return router
}

interface PoolInjection {
  pool: BasePool
}

async function getTransactionsV2(req: Request, res: Response, { pool }: PoolInjection) {
  validateBatch([[checkGetTransactionsV2, req.query]])

  const toV2Format = (prefix: string) => (tx: string) => {
    const outCommit = tx.slice(0, 64)
    const txHash = tx.slice(64, 128)
    const memo = tx.slice(128)
    return prefix + txHash + outCommit + memo
  }

  // Types checked at validation stage
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
