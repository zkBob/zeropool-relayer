import express from 'express'
import config from '../../configs/relayerConfig'
import { logger } from '../../lib/appLogger'
import { createPersistentLoggerMiddleware } from '../../lib/loggerMiddleware'
import { init } from './init'
import { createRouter } from './router'

init().then(({ feeManager, pool }) => {
  const app = express()

  if (config.RELAYER_EXPRESS_TRUST_PROXY) {
    app.set('trust proxy', true)
  }

  app.use(createPersistentLoggerMiddleware(config.RELAYER_REQUEST_LOG_PATH))
  // app.use(createConsoleLoggerMiddleware())

  app.use(createRouter({ feeManager, pool }))
  const PORT = config.RELAYER_PORT
  app.listen(PORT, () => logger.info(`Started relayer on port ${PORT}`))
})
