import { logger } from '@/services/appLogger'
import express from 'express'
import config from '../configs/commitmentWatcherConfig'
import { init } from './init'

init().then(() => {
  const app = express()

  const PORT = config.COMMITMENT_WATCHER_PORT

  app.listen(PORT, () => logger.info(`Started commitment-watcher on port ${PORT}`))
})
