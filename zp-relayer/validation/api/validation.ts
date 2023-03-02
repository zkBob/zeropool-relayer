import Ajv, { JSONSchemaType } from 'ajv'
import { isAddress } from 'web3-utils'
import { Proof, SnarkProof } from 'libzkbob-rs-node'
import { TxType } from 'zp-memo-parser'
import type { PoolTx } from '@/pool'
import { HEADER_TRACE_ID, ZERO_ADDRESS } from '@/utils/constants'
import config from '@/configs/relayerConfig'
import { logger } from '@/services/appLogger'

const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true })

ajv.addKeyword({
  keyword: 'isAddress',
  validate: (schema: any, address: string) => {
    return isAddress(address)
  },
  errors: true,
})

ajv.addKeyword({
  keyword: 'isDivBy128',
  validate: (schema: any, n: number) => {
    return n % 128 === 0
  },
  errors: true,
})

const AjvString: JSONSchemaType<string> = { type: 'string' }
const AjvNullableString: JSONSchemaType<string> = { type: 'string', nullable: true }

const AjvNullableAddress: JSONSchemaType<string> = {
  type: 'string',
  pattern: '^0x[a-fA-F0-9]{40}$',
  default: ZERO_ADDRESS,
  isAddress: true,
}

const AjvG1Point: JSONSchemaType<[string, string]> = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: [AjvString, AjvString],
}

const AjvG2Point: JSONSchemaType<[[string, string], [string, string]]> = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: [AjvG1Point, AjvG1Point],
}

const AjvSnarkProofSchema: JSONSchemaType<SnarkProof> = {
  type: 'object',
  properties: {
    a: AjvG1Point,
    b: AjvG2Point,
    c: AjvG1Point,
  },
  required: ['a', 'b', 'c'],
}

const AjvProofSchema: JSONSchemaType<Proof> = {
  type: 'object',
  properties: {
    inputs: {
      type: 'array',
      items: { type: 'string' },
    },
    proof: AjvSnarkProofSchema,
  },
  required: ['inputs', 'proof'],
}

const AjvSendTransactionSchema: JSONSchemaType<PoolTx> = {
  type: 'object',
  properties: {
    proof: AjvProofSchema,
    memo: AjvString,
    txType: {
      type: 'string',
      enum: [TxType.DEPOSIT, TxType.PERMITTABLE_DEPOSIT, TxType.TRANSFER, TxType.WITHDRAWAL],
    },
    depositSignature: AjvNullableString,
  },
  required: ['proof', 'memo', 'txType'],
}

const AjvSendTransactionsSchema: JSONSchemaType<PoolTx[]> = {
  type: 'array',
  items: AjvSendTransactionSchema,
}

const AjvGetTransactionsV2Schema: JSONSchemaType<{
  limit: number
  offset: number
}> = {
  type: 'object',
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      default: 100,
    },
    offset: {
      type: 'integer',
      minimum: 0,
      default: 0,
    },
  },
  required: [],
}

const AjvGetLimitsSchema: JSONSchemaType<{
  address: string
}> = {
  type: 'object',
  properties: {
    address: AjvNullableAddress,
  },
  required: [],
}

const AjvMerkleRootSchema: JSONSchemaType<{
  index: string | number
}> = {
  type: 'object',
  properties: {
    index: {
      type: 'integer',
    },
  },
  required: ['index'],
}

const AjvGetSiblingsSchema: JSONSchemaType<{
  index: string | number
}> = {
  type: 'object',
  properties: {
    index: {
      type: 'integer',
      minimum: 1,
      isDivBy128: true,
    },
  },
  required: ['index'],
}

const AjvTraceIdSchema: JSONSchemaType<{ [HEADER_TRACE_ID]: string }> = {
  type: 'object',
  properties: { [HEADER_TRACE_ID]: AjvNullableString },
  required: config.requireTraceId ? [HEADER_TRACE_ID] : [],
}

function checkErrors<T>(schema: JSONSchemaType<T>) {
  const validate = ajv.compile(schema)
  return (data: any) => {
    validate(data)
    if (validate.errors) {
      return validate.errors.map(e => {
        return { path: e.instancePath, message: e.message }
      })
    }
    return null
  }
}

type ValidationFunction = ReturnType<typeof checkErrors>

export class ValidationError extends Error {
  constructor(public validationErrors: ReturnType<ValidationFunction>) {
    super()
  }
}

export function validateBatch(validationSet: [ValidationFunction, any][]) {
  for (const [validate, data] of validationSet) {
    const errors = validate(data)
    if (errors) throw new ValidationError(errors)
  }
  return null
}

export const checkMerkleRootErrors = checkErrors(AjvMerkleRootSchema)
export const checkSendTransactionsErrors = checkErrors(AjvSendTransactionsSchema)
export const checkGetTransactionsV2 = checkErrors(AjvGetTransactionsV2Schema)
export const checkGetLimits = checkErrors(AjvGetLimitsSchema)
export const checkGetSiblings = checkErrors(AjvGetSiblingsSchema)
export const checkTraceId = checkErrors(AjvTraceIdSchema)

async function fetchSafe(url: string) {
  const r = await fetch(url)
  if (!r.ok) {
    throw new Error(`HTTP status code: ${r.status}`)
  }
  return r
}

export async function validateCountryIP(ip: string) {
  if (config.blockedCountries.length === 0) return null

  const apis = [
    fetchSafe(`https://ipapi.co/${ip}/country`).then(res => res.text()),
    fetchSafe(`https://api.country.is/${ip}`)
      .then(res => res.json())
      .then(data => data.country),
  ]
  const country: string = await Promise.any(apis).catch(e => {
    const errors = (e as AggregateError).errors
    logger.error('Failed to fetch country by ip', errors)
    throw new ValidationError([
      {
        path: 'ip',
        message: 'Could not validate user IP',
      },
    ])
  })

  if (config.blockedCountries.includes(country)) {
    logger.warn('Restricted country', { ip, country })
    throw new ValidationError([
      {
        path: 'ip',
        message: `Country ${country} is restricted`,
      },
    ])
  }

  return null
}
