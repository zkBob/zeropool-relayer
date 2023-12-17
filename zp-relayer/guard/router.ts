import cors from 'cors'
import express, { NextFunction, Request, Response } from 'express'
import { checkSignMPCSchema, validateBatch } from '../validation/api/validation'
import { logger } from '../services/appLogger'
import { validateTxMPC } from '../validation/tx/validateTx'
import type { Pool } from '@/pool'
import { TxData, buildTxData } from '@/txProcessor'
import { Signer } from 'ethers'
import { truncateHexPrefix } from '@/utils/helpers'
import { VK } from 'libzkbob-rs-node'

function wrapErr(f: (_req: Request, _res: Response, _next: NextFunction) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await f(req, res, next)
    } catch (e) {
      next(e)
    }
  }
}

export function createRouter({ pool, signer }: { pool: Pool; signer: Signer }) {
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

  router.post(
    '/sign',
    wrapErr(async (req: Request, res: Response) => {
      validateBatch([[checkSignMPCSchema, req.body]])
      const message = req.body as TxData

      // Validate
      const vk: VK = require('../params/tree_verification_key.json') // TODO: config vk
      try {
        await validateTxMPC(message, pool, vk)
      } catch (e) {
        console.log('Validation error', e)
        throw new Error('Invalid transaction')
      }

      // Sign
      const calldata = truncateHexPrefix(buildTxData(message))
      const signature = await signer.signMessage(calldata)

      res.json({ signature })
    })
  )

  return router
}
