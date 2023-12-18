import express from 'express'
import { logger } from '../services/appLogger'
import { createRouter } from './router'
import { init } from './init'
import config from '@/configs/guardConfig'

const app = express()

init().then(({ signer, poolContract }) => {
  app.use(createRouter({ signer, poolContract }))
  const PORT = config.GUARD_PORT
  app.listen(PORT, () => logger.info(`Started guard on port ${PORT}`))
})
