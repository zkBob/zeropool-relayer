import { logger } from '@/lib/appLogger'
import { BasePool } from '@/pool/BasePool'
import { inject, txToV2Format } from '@/utils/helpers'
import { checkGetRoot, checkGetTransactionsV2, validateBatch } from '@/validation/api/validation'
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
  router.get('/root', wrapErr(inject({ pool }, getRoot)))

  return router
}

interface PoolInjection {
  pool: BasePool
}

async function getTransactionsV2(req: Request, res: Response, { pool }: PoolInjection) {
  validateBatch([[checkGetTransactionsV2, req.query]])

  // Types checked at validation stage
  const limit = req.query.limit as unknown as number
  const offset = req.query.offset as unknown as number

  const txs: string[] = []
  const { txs: poolTxs, nextOffset } = await pool.state.getTransactions(limit, offset)
  txs.push(...poolTxs.map(tx => txToV2Format('1', tx)))

  if (txs.length < limit) {
    const { txs: optimisticTxs } = await pool.optimisticState.getTransactions(limit - txs.length, nextOffset)
    txs.push(...optimisticTxs.map(tx => txToV2Format('2', tx)))
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

function getRoot(req: Request, res: Response, { pool }: PoolInjection) {
  validateBatch([[checkGetRoot, req.query]])

  const index = req.query.index as unknown as number
  const root = pool.state.getMerkleRootAt(index) ?? pool.optimisticState.getMerkleRootAt(index)

  res.json({ root })
}
