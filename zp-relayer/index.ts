import express from 'express'
import { createRouter } from './router'
import { logger } from './services/appLogger'
import { createConsoleLoggerMiddleware, createPersistentLoggerMiddleware } from './services/loggerMiddleware'
import config from './configs/relayerConfig'
import { init } from './init'

init().then(({ feeManager, pool }) => {
  const app = express()

  if (config.RELAYER_EXPRESS_TRUST_PROXY) {
    app.set('trust proxy', true)
  }

  app.use(createPersistentLoggerMiddleware(config.RELAYER_REQUEST_LOG_PATH))
  app.use(createConsoleLoggerMiddleware())

  app.use(createRouter({ feeManager, pool }))
  const PORT = config.RELAYER_PORT
  app.listen(PORT, () => logger.info(`Started relayer on port ${PORT}`))
})
