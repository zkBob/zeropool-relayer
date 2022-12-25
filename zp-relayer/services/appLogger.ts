import { createLogger, format, transports } from 'winston'
import config from '@/config'

export const logger = createLogger({
  level: config.logLevel,
  format: format.combine(format.colorize(), format.timestamp(), format.splat(), format.simple()),
  transports: [
    new transports.Console({
      format: format.printf(options => {
        const log = `${options.level}: ${options.prefix || ''}${options.message}`
        const suffix = ` ${JSON.stringify({
          ...options.data,
          timestamp: options.timestamp,
        })}`

        return log + suffix
      }),
    }),
  ],
})

export const scopedLogger = (prefix: string, data?: Object) => {
  return logger.child({ prefix, data })
}
