import express from 'express'
import router from './router'
import { logger } from './services/appLogger'
import { createConsoleLoggerMiddleware, createPersistentLoggerMiddleware } from './services/loggerMiddleware'
import config from './configs/relayerConfig'
import { init } from './init'

init().then(() => {
  const app = express()

  app.use(createPersistentLoggerMiddleware(config.requestLogPath))
  app.use(createConsoleLoggerMiddleware())

  app.use(router)
  const PORT = config.port
  app.listen(PORT, () => logger.info(`Started relayer on port ${PORT}`))
})
