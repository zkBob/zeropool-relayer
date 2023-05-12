import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import semver from 'semver'
import endpoints from './endpoints'
import { logger } from './services/appLogger'
import { ValidationError } from './validation/api/validation'
import config from './configs/relayerConfig'
import { HEADER_LIBJS, HEADER_TRACE_ID, LIBJS_MIN_VERSION } from './utils/constants'

function wrapErr(f: (_req: Request, _res: Response, _next: NextFunction) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await f(req, res, next)
    } catch (e) {
      next(e)
    }
  }
}

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

  router.use((req: Request, res: Response, next: NextFunction) => {
    const traceId = req.headers[HEADER_TRACE_ID]
    if (config.requireTraceId && traceId) {
      logger.info('TraceId', { traceId, path: req.path })
    }

    if (config.requireLibJsVersion) {
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
  router.post('/sendTransactions', wrapErr(endpoints.sendTransactions))
  router.get('/transactions/v2', wrapErr(endpoints.getTransactionsV2))
  router.get('/merkle/root/:index?', wrapErr(endpoints.merkleRoot))
  router.get('/job/:id', wrapErr(endpoints.getJob))
  router.get('/info', wrapErr(endpoints.relayerInfo))
  router.get('/fee', wrapErr(endpoints.getFee))
  router.get('/limits', wrapErr(endpoints.getLimits))
  router.get('/maxNativeAmount', wrapErr(endpoints.getMaxNativeAmount))
  router.get('/siblings', wrapErr(endpoints.getSiblings))
  router.get('/params/hash/tree', wrapErr(endpoints.getParamsHash(config.treeUpdateParamsPath)))
  router.get('/params/hash/tx', wrapErr(endpoints.getParamsHash(config.transferParamsPath)))
  router.get('/params/hash/direct-deposit', wrapErr(endpoints.getParamsHash(config.directDepositParamsPath)))

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
