import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import { ValidationError } from 'express-json-validator-middleware'
import {
  validator,
  AjvMerkleRootSchema,
  AjvSendTransactionSchema,
  AjvSendTransactionsSchema,
  AjvGetTransactionsV2Schema,
  AjvGetTransactionsSchema,
  AjvGetLimitsSchema,
} from './validation/validation'
import endpoints from './endpoints'
import { logger } from './services/appLogger'

function wrapErr(f: (_req: Request, _res: Response, _next: NextFunction) => Promise<void> | void) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await f(req, res, next)
    } catch (e) {
      next(e)
    }
  }
}

const router = express.Router()

router.use(cors())
router.use(express.urlencoded({ extended: true }))
router.use(express.json())
router.use(express.text())

router.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (err) {
    console.error('Request error:', err)
    return res.sendStatus(500)
  }
  next()
})

const { validate } = validator

router.get('/', endpoints.root)
router.post('/sendTransaction', validate({ body: AjvSendTransactionSchema }), wrapErr(endpoints.sendTransaction))
router.post('/sendTransactions', validate({ body: AjvSendTransactionsSchema }), wrapErr(endpoints.sendTransactions))
router.get('/transactions', validate({ query: AjvGetTransactionsSchema }), wrapErr(endpoints.getTransactions))
router.get('/transactions/v2', validate({ query: AjvGetTransactionsV2Schema }), wrapErr(endpoints.getTransactionsV2))
router.get('/merkle/root/:index?', validate({ params: AjvMerkleRootSchema }), wrapErr(endpoints.merkleRoot))
router.get('/job/:id', wrapErr(endpoints.getJob))
router.get('/info', wrapErr(endpoints.relayerInfo))
router.get('/fee', wrapErr(endpoints.getFee))
router.get('/limits', validate({ query: AjvGetLimitsSchema }), wrapErr(endpoints.getLimits))
router.get('/params/hash/tree', wrapErr(endpoints.getParamsHash('tree')))
router.get('/params/hash/tx', wrapErr(endpoints.getParamsHash('transfer')))

// Validation error handler
router.use((error: any, req: Request, res: Response, next: NextFunction) => {
  if (error instanceof ValidationError) {
    const errors = error.validationErrors
    logger.info('Invalid request: %o', errors)
    res.status(400).json({ errors })
    next()
  } else {
    next(error)
  }
})

export default router
