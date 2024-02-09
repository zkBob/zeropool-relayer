import { logger } from '@/services/appLogger'
import type { Redis } from 'ioredis'
import type Web3 from 'web3'
import { getNonce } from './web3'

export enum RelayerKeys {
  NONCE = `relayer:nonce`,
}

export const readNonce = (redis: Redis, web3: Web3, address: string) =>
  readFieldBuilder(redis, RelayerKeys.NONCE, () => getNonce(web3, address))

function readFieldBuilder(redis: Redis, key: RelayerKeys, forceUpdateFunc?: Function) {
  return async (forceUpdate?: boolean) => {
    const update = () => {
      if (!forceUpdateFunc) throw new Error('Force update function not provided')
      return forceUpdateFunc()
    }

    logger.debug(`Reading ${key}`)
    if (forceUpdate) {
      logger.debug(`Forcing update of ${key}`)
      return update()
    }

    const val = await redis.get(key)
    if (val) {
      logger.debug(`${key} found in the DB: ${val}`)
      return val
    } else {
      logger.warn(`${key} wasn't found in the DB`)
      return update()
    }
  }
}

export function updateField(redis: Redis, key: RelayerKeys, val: any) {
  return redis.set(key, val)
}

export function updateNonce(redis: Redis, nonce: number) {
  return updateField(redis, RelayerKeys.NONCE, nonce)
}
