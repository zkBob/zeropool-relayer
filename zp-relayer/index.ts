import express from 'express'
import { createRouter } from './router'
import { logger } from './services/appLogger'
import { createConsoleLoggerMiddleware, createPersistentLoggerMiddleware } from './services/loggerMiddleware'
import config from './configs/relayerConfig'
import { init } from './init'

init().then(() => {
  const app = express()

  if (config.trustProxy) {
    app.set('trust proxy', true)
  }

  app.use(createPersistentLoggerMiddleware(config.requestLogPath))
  app.use(createConsoleLoggerMiddleware())

  app.use(createRouter())
  const PORT = config.port
  app.listen(PORT, () => logger.info(`Started relayer on port ${PORT}`))
})
