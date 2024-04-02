import expressWinston from 'express-winston'
import { format, transports } from 'winston'
import { logger } from './appLogger'

export function createPersistentLoggerMiddleware(filename: string = 'zp.log') {
  return expressWinston.logger({
    transports: [new transports.File({ filename })],
    format: format.combine(format.json()),
  })
}

export function createConsoleLoggerMiddleware(ignoredRoutes: string[] = [], headerBlacklist: string[] = []) {
  return expressWinston.logger({
    winstonInstance: logger,
    level: 'debug',
    ignoredRoutes,
    headerBlacklist,
    requestWhitelist: ['headers', 'httpVersion'],
  })
}
