import config from '@/configs/guardConfig'
import express from 'express'
import { logger } from '../../lib/appLogger'
import { init } from './init'
import { createRouter } from './router'

const app = express()

init().then(({ poolContract }) => {
  app.use(createRouter({ poolContract }))
  const PORT = config.GUARD_PORT
  app.listen(PORT, () => logger.info(`Started guard on port ${PORT}`))
})
