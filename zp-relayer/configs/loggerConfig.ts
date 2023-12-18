import { z } from 'zod'

export const zBooleanString = () => z.enum(['true', 'false']).transform(value => value === 'true')

const schema = z.object({
  COMMON_COLORIZE_LOGS: zBooleanString().default('false'),
  COMMON_LOG_LEVEL: z.string().default('debug'),
})

const config = schema.parse(process.env)

export default config
