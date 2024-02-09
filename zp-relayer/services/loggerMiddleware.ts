import config from '@/configs/relayerConfig'
import expressWinston from 'express-winston'
import { format, transports } from 'winston'
import { logger } from './appLogger'

export function createPersistentLoggerMiddleware(filename: string = 'zp.log') {
  return expressWinston.logger({
    transports: [new transports.File({ filename })],
    format: format.combine(format.json()),
  })
}

export function createConsoleLoggerMiddleware() {
  return expressWinston.logger({
    winstonInstance: logger,
    level: 'debug',
    ignoredRoutes: config.RELAYER_LOG_IGNORE_ROUTES,
    headerBlacklist: config.RELAYER_LOG_HEADER_BLACKLIST,
    requestWhitelist: ['headers', 'httpVersion'],
  })
}
