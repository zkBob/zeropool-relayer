import config from '@/configs/loggerConfig'
import { createLogger, format, transports } from 'winston'

let logFormat = format.combine(format.timestamp(), format.splat(), format.simple())
if (config.LOGGER_COLORIZE_LOGS) {
  logFormat = format.combine(format.colorize(), logFormat)
}

export const logger = createLogger({
  level: config.LOGGER_LOG_LEVEL,
  format: logFormat,
  transports: [new transports.Console()],
})
