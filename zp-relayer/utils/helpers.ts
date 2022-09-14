import BN from 'bn.js'
import { padLeft, toBN } from 'web3-utils'
import { logger } from '@/services/appLogger'
import { SnarkProof } from 'libzkbob-rs-node'
import { TxType } from 'zp-memo-parser'
import type { Mutex } from 'async-mutex'

const S_MASK = toBN('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
const S_MAX = toBN('0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0')

export function toTxType(t: string): TxType {
  t = truncateHexPrefix(t)
  if (t === TxType.DEPOSIT || t === TxType.TRANSFER || t === TxType.WITHDRAWAL || t === TxType.PERMITTABLE_DEPOSIT) {
    return t
  } else {
    throw new Error('incorrect tx type')
  }
}

const txTypePrefixLen = {
  [TxType.DEPOSIT]: 16,
  [TxType.TRANSFER]: 16,
  // 16 + 16 + 40
  [TxType.WITHDRAWAL]: 72,
  [TxType.PERMITTABLE_DEPOSIT]: 72,
}

export function truncateMemoTxPrefix(memo: string, txType: TxType) {
  const txSpecificPrefixLen = txTypePrefixLen[txType]
  return memo.slice(txSpecificPrefixLen)
}

export function truncateHexPrefix(data: string) {
  if (data.startsWith('0x')) {
    data = data.slice(2)
  }
  return data
}

export function numToHex(num: BN, pad = 64) {
  if (num.isNeg()) {
    let a = toBN(2).pow(toBN(pad * 4))
    num = a.sub(num.neg())
  }
  const hex = num.toString('hex')
  if (hex.length > pad) {
    logger.error(`hex size overflow: ${hex}; pad: ${pad}`)
  }
  return padLeft(hex, pad)
}

export function unpackSignature(packedSign: string) {
  if (packedSign.length === 130) {
    return '0x' + packedSign
  }

  if (packedSign.length !== 128) {
    throw new Error('Invalid packed signature length')
  }

  const r = packedSign.slice(0, 64)
  const vs = packedSign.slice(64)

  const vs_BN = toBN(vs)
  const v = numToHex(toBN(27).add(vs_BN.shrn(255)), 2)

  const s_BN = vs_BN.and(S_MASK)
  const s = numToHex(s_BN)

  if (s_BN.gt(S_MAX)) {
    throw new Error(`Invalid signature 's' value`)
  }

  const sig = '0x' + r + s + v

  // 2 + 64 + 64 + 2 = 132
  if (sig.length !== 132) {
    throw new Error('Invalid resulting signature length')
  }

  return sig
}

export function flattenProof(p: SnarkProof): string {
  return [p.a, p.b.flat(), p.c]
    .flat()
    .map(n => {
      const hex = numToHex(toBN(n))
      return hex
    })
    .join('')
}

export async function setIntervalAndRun(f: () => Promise<void> | void, interval: number) {
  const handler = setInterval(f, interval)
  await f()
  return handler
}

export async function withMutex<R>(mutex: Mutex, f: () => Promise<R>): Promise<R> {
  const release = await mutex.acquire()
  try {
    const res = await f()
    return res
  } catch (e) {
    throw e
  } finally {
    release()
  }
}
