import { format, transports } from 'winston'
import expressWinston from 'express-winston'
import config from '@/config'
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
    ignoredRoutes: config.logIgnoreRoutes,
    headerBlacklist: [
      'accept',
      'accept-language',
      'accept-encoding',
      'connection',
      'content-length',
      'content-type',
      'postman-token',
      'referer',
      'upgrade-insecure-requests',
    ],
    requestWhitelist: ['headers', 'httpVersion'],
  })
}
