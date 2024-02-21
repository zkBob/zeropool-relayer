import config from '@/configs/commitmentWatcherConfig'
import { poolTxQueue, WorkerTx, WorkerTxType } from '@/queue/poolTxQueue'
import { logger } from '@/services/appLogger'
import { ValidationError } from '@/validation/api/validation'
import cors from 'cors'
import express, { NextFunction, Request, Response } from 'express'

export function createRouter() {
  const router = express.Router()

  router.use(cors())
  router.use(express.urlencoded({ extended: true }))
  router.use(express.json())
  router.use(express.text())

  router.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (err) {
      logger.error('Request error:', err)
      return res.sendStatus(500)
    }
    next()
  })

  router.get('/address', (req, res) => {
    res.json({ address: config.txManager.TX_ADDRESS })
  })

  router.get('/fee', (req, res) => {
    res.json({ fee: config.COMMITMENT_WATCHER_FEE })
  })

  router.get('/job/:commitment', async (req, res) => {
    const jobId = req.params.commitment
    const job = await poolTxQueue.getJob(jobId)
    if (job) {
      const { outCommit, privilegedProver, fee, timestamp, gracePeriodEnd, txHash, state } = job.data
        .transaction as WorkerTx<WorkerTxType.Finalize>
      res.json({
        outCommit,
        privilegedProver,
        fee,
        timestamp,
        gracePeriodEnd,
        txHash,
        state,
      })
    } else {
      res.json(`Job ${jobId} not found`)
    }
  })

  // Error handler middleware
  router.use((error: any, req: Request, res: Response, next: NextFunction) => {
    if (error instanceof ValidationError) {
      const validationErrors = error.validationErrors
      logger.warn('Validation errors', { errors: validationErrors, path: req.path })
      res.status(400).json(validationErrors)
    } else {
      logger.error('Internal error', { error, path: req.path })
      res.status(500).send('Internal server error')
    }
  })

  return router
}
