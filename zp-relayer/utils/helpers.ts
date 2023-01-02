import type Web3 from 'web3'
import type BN from 'bn.js'
import { padLeft, toBN } from 'web3-utils'
import { logger } from '@/services/appLogger'
import type { SnarkProof } from 'libzkbob-rs-node'
import { TxType } from 'zp-memo-parser'
import type { Mutex } from 'async-mutex'
import promiseRetry from 'promise-retry'

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

export function buildPrefixedMemo(outCommit: string, txHash: string, truncatedMemo: string) {
  return numToHex(toBN(outCommit)).concat(txHash.slice(2)).concat(truncatedMemo)
}

export async function setIntervalAndRun(f: () => Promise<void> | void, interval: number) {
  const handler = setInterval(f, interval)
  await f()
  return handler
}

export function withMutex<R>(mutex: Mutex, f: () => Promise<R>): () => Promise<R> {
  return async () => {
    const release = await mutex.acquire()
    try {
      return await f()
    } finally {
      release()
    }
  }
}

export async function withErrorLog<R>(
  f: () => Promise<R>,
  WarnErrors: (new (...args: any[]) => Error)[] = []
): Promise<R> {
  try {
    return await f()
  } catch (e) {
    const err = e as Error
    const isWarn = WarnErrors.some(WarnError => err instanceof WarnError)
    if (isWarn) {
      logger.warn('%s: %s', err.name, err.message)
    } else {
      logger.error('Found error: %s', err.message)
    }
    throw e
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function withLoop<R>(f: () => Promise<R>, timeout: number, suppressedErrors: string[] = []): () => Promise<R> {
  // @ts-ignore
  return async () => {
    while (1) {
      try {
        return await f()
      } catch (e) {
        const err = e as Error
        let isSuppressed = false
        for (let suppressedError of suppressedErrors) {
          if (err.message.includes(suppressedError)) {
            isSuppressed = true
            break
          }
        }

        if (isSuppressed) {
          logger.warn('%s', err.message)
        } else {
          logger.error('Found error %s', err.message)
        }

        await sleep(timeout)
      }
    }
  }
}

export function waitForFunds(
  web3: Web3,
  address: string,
  cb: (balance: BN) => void,
  minimumBalance: BN,
  timeout: number,
) {
  return promiseRetry(
    async retry => {
      logger.debug('Getting relayer balance')
      const newBalance = toBN(await web3.eth.getBalance(address))
      const balanceLog = { balance: newBalance.toString(10), minimumBalance: minimumBalance.toString(10) }
      if (newBalance.gte(minimumBalance)) {
        logger.info('Relayer has minimum necessary balance', balanceLog)
        cb(newBalance)
      } else {
        logger.warn('Relayer balance is still less than the minimum', balanceLog)
        retry(new Error('Not enough balance'))
      }
    },
    {
      forever: true,
      factor: 1,
      maxTimeout: timeout,
      minTimeout: timeout,
    }
  )

export function checkHTTPS(isRequired: boolean) {
  return (url: string) => {
    if (!/^https.*/.test(url)) {
      if (isRequired) {
        throw new Error(`http is not allowed: ${url}`)
      } else {
        logger.warn('HTTP RPC URL is not recommended for production usage')
      }
    }
  }
}
