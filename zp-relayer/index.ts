import './env'
import express from 'express'
import router from './router'
import { logger } from './services/appLogger'
import { createConsoleLoggerMiddleware, createPersistentLoggerMiddleware } from './services/loggerMiddleware'
import config from './config'
import { init } from './init'

const app = express()

app.use(createPersistentLoggerMiddleware('zp.log'))
app.use(createConsoleLoggerMiddleware())

app.use(router)

init().then(() => {
  const PORT = config.port
  app.listen(PORT, () => logger.info(`Started relayer on port ${PORT}`))
})
