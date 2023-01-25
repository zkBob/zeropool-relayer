import { createLogger, format, transports, Logger } from 'winston'

export let logger: Logger

export function initLogger(level: string) {
  logger = createLogger({
    level,
    format: format.combine(format.colorize(), format.timestamp(), format.splat(), format.simple()),
    transports: [new transports.Console()],
  })
}
