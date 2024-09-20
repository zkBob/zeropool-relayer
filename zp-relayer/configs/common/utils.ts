import { toBN } from 'web3-utils'
import { z } from 'zod'

export const zBN = () => z.string().transform(toBN)
export const zBooleanString = () => z.enum(['true', 'false']).transform(value => value === 'true')
export const zNullishString = () =>
  z
    .string()
    .optional()
    .transform(x => x ?? null)
