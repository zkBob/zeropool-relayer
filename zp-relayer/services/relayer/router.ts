import config from '@/configs/relayerConfig'
import { logger } from '@/lib/appLogger'
import type { FeeManager } from '@/lib/fee'
import type { BasePool } from '@/pool/BasePool'
import { getFileHash, inject } from '@/utils/helpers'
import { ValidationError } from '@/validation/api/validation'
import cors from 'cors'
import express, { NextFunction, Request, Response } from 'express'
import semver from 'semver'
import { HEADER_LIBJS, HEADER_TRACE_ID, LIBJS_MIN_VERSION } from '../../utils/constants'
import endpoints from './endpoints'

interface IRouterConfig {
  feeManager: FeeManager
  pool: BasePool
}

function wrapErr(f: (_req: Request, _res: Response, _next: NextFunction) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await f(req, res, next)
    } catch (e) {
      next(e)
    }
  }
}

export function createRouter({ feeManager, pool }: IRouterConfig) {
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

  router.use((req: Request, res: Response, next: NextFunction) => {
    const traceId = req.headers[HEADER_TRACE_ID]
    if (config.RELAYER_REQUIRE_TRACE_ID && traceId) {
      logger.info('TraceId', { traceId, path: req.path })
    }

    if (config.RELAYER_REQUIRE_LIBJS_VERSION) {
      const libJsVersion = req.headers[HEADER_LIBJS] as string
      let isValidVersion = false
      try {
        isValidVersion = semver.gte(libJsVersion, LIBJS_MIN_VERSION)
      } catch (e) {
        logger.warn('Invalid libjs version header', { libJsVersion })
      }

      if (!isValidVersion) {
        throw new ValidationError([{ path: HEADER_LIBJS, message: `Minimum supported version: ${LIBJS_MIN_VERSION}` }])
      }
    }

    next()
  })

  router.get('/', endpoints.root)
  router.get('/version', endpoints.relayerVersion)
  router.get(
    '/address',
    wrapErr((_, res) => {
      res.json({ address: config.txManager.TX_ADDRESS })
    })
  )
  router.get('/proverFee', wrapErr(endpoints.getProverFee))
  router.get('/proverAddress', wrapErr(endpoints.getProverAddress))
  router.post('/sendTransactions', wrapErr(inject({ pool }, endpoints.sendTransactions)))
  router.get('/transactions/v2', wrapErr(inject({ pool }, endpoints.getTransactionsV2)))
  router.get('/merkle/root/:index?', wrapErr(inject({ pool }, endpoints.merkleRoot)))
  router.get('/job/:id', wrapErr(inject({ pool }, endpoints.getJob)))
  router.get('/info', wrapErr(inject({ pool }, endpoints.relayerInfo)))
  router.get('/fee', wrapErr(inject({ pool, feeManager }, endpoints.getFee)))
  router.get('/limits', wrapErr(inject({ pool }, endpoints.getLimits)))
  router.get('/maxNativeAmount', wrapErr(endpoints.getMaxNativeAmount))
  router.get('/siblings', wrapErr(inject({ pool }, endpoints.getSiblings)))
  router.get(
    '/params/hash/tree',
    wrapErr(inject({ hash: getFileHash(config.RELAYER_TREE_UPDATE_PARAMS_PATH) }, endpoints.getParamsHash))
  )
  router.get(
    '/params/hash/tx',
    wrapErr(inject({ hash: getFileHash(config.RELAYER_TRANSFER_PARAMS_PATH) }, endpoints.getParamsHash))
  )
  router.get('/params/hash/direct-deposit', wrapErr(inject({ hash: getFileHash(null) }, endpoints.getParamsHash)))

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
