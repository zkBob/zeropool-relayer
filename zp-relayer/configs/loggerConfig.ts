import { z } from 'zod'
import { zBooleanString } from './common/utils'

const schema = z.object({
  LOGGER_COLORIZE_LOGS: zBooleanString().default('false'),
  LOGGER_LOG_LEVEL: z.string().default('debug'),
})

const config = schema.parse(process.env)

export default config
