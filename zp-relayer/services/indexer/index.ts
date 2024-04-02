import config from '@/configs/indexerConfig'
import { logger } from '@/lib/appLogger'
import { createConsoleLoggerMiddleware, createPersistentLoggerMiddleware } from '@/lib/loggerMiddleware'
import express from 'express'
import { init } from './init'
import { createRouter } from './router'

init().then(({ pool }) => {
  const app = express()

  if (config.INDEXER_EXPRESS_TRUST_PROXY) {
    app.set('trust proxy', true)
  }

  app.use(createPersistentLoggerMiddleware(config.INDEXER_REQUEST_LOG_PATH))
  app.use(createConsoleLoggerMiddleware())

  app.use(createRouter({ pool }))
  const PORT = config.INDEXER_PORT
  app.listen(PORT, () => logger.info(`Started indexer on port ${PORT}`))
})
