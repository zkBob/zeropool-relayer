import config from '@/configs/commitmentWatcherConfig'
import { logger } from '@/lib/appLogger'
import express from 'express'
import { init } from './init'
import { createRouter } from './router'

init().then(() => {
  const app = express()

  app.use(createRouter())
  const PORT = config.COMMITMENT_WATCHER_PORT
  app.listen(PORT, () => logger.info(`Started commitment-watcher on port ${PORT}`))
})
