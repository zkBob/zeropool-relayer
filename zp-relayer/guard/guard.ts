import express from 'express'
import { logger } from '../services/appLogger'
import { createRouter } from './router'
import { init } from './init'

const app = express()

init().then(({ pool, signer }) => {
  app.use(createRouter({ pool, signer }))
  const PORT = 8080
  app.listen(PORT, () => logger.info(`Started guard on port ${PORT}`))
})
