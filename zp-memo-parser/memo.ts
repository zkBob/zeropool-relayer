import { Buffer } from 'buffer'
import { deserialize, BinaryReader } from 'borsh'

type Option<T> = T | null

export enum TxType {
  DEPOSIT = '0000',
  TRANSFER = '0001',
  WITHDRAWAL = '0002',
  PERMITTABLE_DEPOSIT = '0003',
}

interface DefaultTxData {
  fee: string
}

export interface WithdrawTxData extends DefaultTxData {
  nativeAmount: string
  receiver: Uint8Array
}

export interface PermittableDepositTxData extends DefaultTxData {
  deadline: string
  holder: Uint8Array
}

export type TxData<T extends TxType> = T extends TxType.WITHDRAWAL
  ? WithdrawTxData
  : T extends TxType.PERMITTABLE_DEPOSIT
  ? PermittableDepositTxData
  : DefaultTxData

// Size in bytes
const U256_SIZE = 32
const POLY_1305_TAG_SIZE = 16
const ACCOUNT_SIZE = 70
const NOTE_SIZE = 60
const ZERO_NOTE_HASH = Uint8Array.from([
  205, 67, 21, 69, 218, 80, 86, 210, 193, 254, 80, 77, 140, 200, 120, 159, 225, 78, 91, 230, 207, 158, 63, 231, 197,
  180, 251, 16, 82, 219, 170, 14,
])

class Assignable {
  constructor(properties: Object) {
    Object.keys(properties).map(key => {
      // @ts-ignore
      this[key] = properties[key]
    })
  }
}

export class Memo extends Assignable {
  rawBuf!: Uint8Array
  numItems!: number
  accHash!: Uint8Array
  noteHashes!: Uint8Array[]
  rawNoteHashes!: Buffer
  a_p_x!: number
}

function clientBorshSchema(numNotes: number) {
  const fields = [
    ['accHash', [U256_SIZE]],
    ['rawNoteHashes', [numNotes * U256_SIZE]],
    ['a_p_x', 'u256'],
    ['sharedSecretCiphertext', [(numNotes + 1) * U256_SIZE + POLY_1305_TAG_SIZE]],
    ['accountCiphertext', [ACCOUNT_SIZE + POLY_1305_TAG_SIZE]],
  ]
  for (let i = 0; i < numNotes; i++) {
    fields.push([`a_${i}_x`, 'u256'])
    fields.push([`noteCiphertext_${i}`, [NOTE_SIZE + POLY_1305_TAG_SIZE]])
  }
  return new Map([
    [
      Memo,
      {
        kind: 'struct',
        fields,
      },
    ],
  ])
}

function getNoteHashes(rawHashes: Buffer, num: number, maxNotes: number): Uint8Array[] {
  const notes = []
  for (let i = 0; i < num; i++) {
    const start = i * U256_SIZE
    const end = start + U256_SIZE
    const note_hash = Buffer.from(rawHashes.subarray(start, end))
    notes.push(note_hash)
  }
  // Append zero note hashes
  for (let i = num; i < maxNotes; i++) {
    notes.push(ZERO_NOTE_HASH)
  }
  return notes
}

function getAddress(data: Buffer, offset: number): Uint8Array {
  return new Uint8Array(data.subarray(offset, offset + 20))
}

export function getTxData<T extends TxType>(data: Buffer, txType: Option<T>): TxData<T> {
  function readU64(offset: number) {
    let uint = data.readBigUInt64BE(offset)
    return uint.toString(10)
  }
  let offset = 0
  const fee = readU64(offset)
  offset += 8
  if (txType === TxType.WITHDRAWAL) {
    const nativeAmount = readU64(offset)
    offset += 8
    const receiver = getAddress(data, offset)
    return {
      fee,
      nativeAmount,
      receiver,
    } as TxData<T>
  } else if (txType === TxType.PERMITTABLE_DEPOSIT) {
    const deadline = readU64(offset)
    offset += 8
    const holder = getAddress(data, offset)
    return {
      fee,
      deadline,
      holder,
    } as TxData<T>
  }
  return { fee } as TxData<T>
}

export function decodeMemo(data: Buffer, maxNotes = 127) {
  const reader = new BinaryReader(data)
  const numItems = new DataView(reader.readFixedArray(4).buffer).getUint32(0, true)
  const memo: Memo = deserialize(clientBorshSchema(numItems - 1), Memo, data.subarray(reader.offset))
  memo.numItems = numItems
  memo.noteHashes = getNoteHashes(memo.rawNoteHashes, numItems - 1, maxNotes)
  memo.rawBuf = data
  return memo
}
