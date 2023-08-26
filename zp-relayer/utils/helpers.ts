import fs from 'fs'
import crypto from 'crypto'
import type BN from 'bn.js'
import type Web3 from 'web3'
import type { Mutex } from 'async-mutex'
import type { Contract } from 'web3-eth-contract'
import type { SnarkProof } from 'libzkbob-rs-node'
import { TxType } from 'zp-memo-parser'
import promiseRetry from 'promise-retry'
import { padLeft, toBN } from 'web3-utils'
import { logger } from '@/services/appLogger'
import { isContractCallError } from './web3Errors'

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

export function flattenProof(p: SnarkProof): string[] {
  return [p.a, p.b, p.c].flat(2)
}

export function encodeProof(p: SnarkProof): string {
  return flattenProof(p)
    .map(n => {
      const hex = numToHex(toBN(n))
      return hex
    })
    .join('')
}

export function buildPrefixedMemo(outCommit: string, txHash: string, truncatedMemo: string) {
  return numToHex(toBN(outCommit)).concat(truncateHexPrefix(txHash)).concat(truncatedMemo)
}

export async function setIntervalAndRun(f: () => Promise<void> | void, interval: number) {
  const handler = setInterval(f, interval)
  await f()
  return handler
}

export function withMutex<F extends (...args: any[]) => any>(
  mutex: Mutex,
  f: F
): (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>> {
  return async (...args) => {
    const release = await mutex.acquire()
    try {
      return await f(...args)
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

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function withLoop<F extends (i: number) => any>(
  f: F,
  timeout: number,
  suppressedErrors: string[] = []
): () => Promise<Awaited<ReturnType<F>>> {
  return async () => {
    let i = 1
    while (1) {
      try {
        return await f(i++)
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
          logger.info('%s', err.message)
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
  timeout: number
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
}

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

export function contractCallRetry(contract: Contract, method: string, args: any[] = []) {
  return promiseRetry(
    async retry => {
      try {
        return await contract.methods[method](...args).call()
      } catch (e) {
        if (isContractCallError(e as Error)) {
          logger.warn('Retrying failed contract call', { method, args })
          retry(e)
        } else {
          logger.debug('Unknown contract call error', { method, args, error: e })
          throw e
        }
      }
    },
    {
      retries: 2,
      minTimeout: 500,
      maxTimeout: 500,
    }
  )
}

export function getFileHash(path: string | null) {
  if (!path) {
    return null
  }

  const buffer = fs.readFileSync(path)
  const hash = crypto.createHash('sha256')
  hash.update(buffer)
  return hash.digest('hex')
}

export function applyDenominator(n: BN, d: BN) {
  return d.testn(255) ? n.div(d.maskn(255)) : n.mul(d)
}
