import Ajv, { JSONSchemaType } from 'ajv'
import { isAddress } from 'web3-utils'
import { Proof, SnarkProof } from 'libzkbob-rs-node'
import { TxType } from 'zp-memo-parser'
import type { PoolTx } from '@/pool'
import { ZERO_ADDRESS } from '@/utils/constants'

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
    depositSignature: { type: 'string', nullable: true },
  },
  required: ['proof', 'memo', 'txType'],
}

const AjvSendTransactionsSchema: JSONSchemaType<PoolTx[]> = {
  type: 'array',
  items: AjvSendTransactionSchema,
}

const AjvGetTransactionsSchema: JSONSchemaType<{
  limit: number
  offset: number
  optimistic: boolean
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
    optimistic: {
      type: 'boolean',
      default: false,
    },
  },
  required: [],
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

export const checkMerkleRootErrors = checkErrors(AjvMerkleRootSchema)
export const checkSendTransactionErrors = checkErrors(AjvSendTransactionSchema)
export const checkSendTransactionsErrors = checkErrors(AjvSendTransactionsSchema)
export const checkGetTransactions = checkErrors(AjvGetTransactionsSchema)
export const checkGetTransactionsV2 = checkErrors(AjvGetTransactionsV2Schema)
export const checkGetLimits = checkErrors(AjvGetLimitsSchema)
export const checkGetSiblings = checkErrors(AjvGetSiblingsSchema)
