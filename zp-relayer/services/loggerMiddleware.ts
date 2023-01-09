import { format, transports } from 'winston'
import expressWinston from 'express-winston'
import config from '@/config'

export function createLoggerMiddleware(filename: string = 'zp.log') {
  return expressWinston.logger({
    transports: [new transports.File({ filename, level: 'debug' }), new transports.Console()],
    format: format.combine(format.colorize(), format.simple()),
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
  })
}
