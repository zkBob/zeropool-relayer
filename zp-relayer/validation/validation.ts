import { Validator } from 'express-json-validator-middleware'
import { isAddress } from 'web3-utils'
import { TxType } from 'zp-memo-parser'
import { ZERO_ADDRESS } from '@/utils/constants'
import type { JSONSchema7 } from 'json-schema'

type SchemaType = JSONSchema7

export const validator = new Validator({ allErrors: true, coerceTypes: true, useDefaults: true })

validator.ajv.addKeyword({
  keyword: 'isAddress',
  validate: (schema: any, address: string) => {
    return isAddress(address)
  },
  errors: true,
})

const AjvString: SchemaType = { type: 'string' }

const AjvNullableAddress: SchemaType = {
  type: 'string',
  pattern: '^0x[a-fA-F0-9]{40}$',
  default: ZERO_ADDRESS,
  // @ts-ignore
  isAddress: true,
}

const AjvG1Point: SchemaType = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: [AjvString, AjvString],
}

const AjvG2Point: SchemaType = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: [AjvG1Point, AjvG1Point],
}

const AjvSnarkProofSchema: SchemaType = {
  type: 'object',
  properties: {
    a: AjvG1Point,
    b: AjvG2Point,
    c: AjvG1Point,
  },
  required: ['a', 'b', 'c'],
}

const AjvProofSchema: SchemaType = {
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

export const AjvSendTransactionSchema: SchemaType = {
  type: 'object',
  properties: {
    proof: AjvProofSchema,
    memo: AjvString,
    txType: {
      type: 'string',
      enum: [TxType.DEPOSIT, TxType.PERMITTABLE_DEPOSIT, TxType.TRANSFER, TxType.WITHDRAWAL],
    },
    depositSignature: {
      type: 'string',
      // @ts-ignore
      nullable: true,
    },
  },
  required: ['proof', 'memo', 'txType'],
}

export const AjvSendTransactionsSchema: SchemaType = {
  type: 'array',
  items: AjvSendTransactionSchema,
}

export const AjvGetTransactionsSchema: SchemaType = {
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

export const AjvGetTransactionsV2Schema: SchemaType = {
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

export const AjvGetLimitsSchema: SchemaType = {
  type: 'object',
  properties: {
    address: AjvNullableAddress,
  },
  required: [],
}

export const AjvMerkleRootSchema: SchemaType = {
  type: 'object',
  properties: {
    index: {
      type: 'integer',
    },
  },
  required: ['index'],
}
