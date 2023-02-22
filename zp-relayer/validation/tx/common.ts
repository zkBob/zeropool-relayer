import config from '@/configs/baseConfig'
import { logger } from '@/services/appLogger'
import { HEADER_TRACE_ID } from '@/utils/constants'

export class TxValidationError extends Error {
  name = 'TxValidationError'
  constructor(message: string) {
    super(message)
  }
}

type OptionError = Error | null
export async function checkAssertion(f: () => Promise<OptionError> | OptionError) {
  const err = await f()
  if (err) {
    throw err
  }
}

export function checkSize(data: string, size: number) {
  return data.length === size
}

export async function checkScreener(address: string, traceId?: string) {
  if (config.screenerUrl === null || config.screenerToken === null) {
    return null
  }

  const ACC_VALIDATION_FAILED = 'Internal account validation failed'

  const headers: Record<string, string> = {
    'Content-type': 'application/json',
    'Authorization': `Bearer ${config.screenerToken}`,
  }

  if (traceId) headers[HEADER_TRACE_ID] = traceId

  try {
    const rawResponse = await fetch(config.screenerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ address }),
    })
    const response = await rawResponse.json()
    if (response.result === true) {
      return new TxValidationError(ACC_VALIDATION_FAILED)
    }
  } catch (e) {
    logger.error('Request to screener failed', { error: (e as Error).message })
    return new TxValidationError(ACC_VALIDATION_FAILED)
  }

  return null
}
