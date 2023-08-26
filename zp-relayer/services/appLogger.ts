import { createLogger, format, transports } from 'winston'
import config from '@/configs/baseConfig'

let logFormat = format.combine(format.timestamp(), format.splat(), format.simple())
if (config.COMMON_COLORIZE_LOGS) {
  logFormat = format.combine(format.colorize(), logFormat)
}

export const logger = createLogger({
  level: config.COMMON_LOG_LEVEL,
  format: logFormat,
  transports: [new transports.Console()],
})
