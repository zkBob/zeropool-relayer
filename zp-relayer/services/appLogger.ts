import { createLogger, format, transports } from 'winston'
import config from '@/configs/baseConfig'

let logFormat = format.combine(format.timestamp(), format.splat(), format.simple())
if (config.colorizeLogs) {
  logFormat = format.combine(format.colorize(), logFormat)
}

export const logger = createLogger({
  level: config.logLevel,
  format: logFormat,
  transports: [new transports.Console()],
})
