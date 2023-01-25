import Web3 from 'web3'
import type { HttpProvider } from 'web3-core'
import { RETRY_CONFIG } from '@/utils/constants'
import HttpListProvider from './providers/HttpListProvider'
import RedundantHttpListProvider from './providers/RedundantHttpListProvider'
import { checkHTTPS } from '@/utils/helpers'
import { SafeEthLogsProvider } from './providers/SafeEthLogsProvider'

export let web3: Web3
export let web3Redundant: Web3

interface InitWeb3Params {
  rpcUrls: string[]
  requireHTTPS: boolean
  rpcRequestTimeout: number
  rpcSyncCheckInterval: number
  relayerTxRedundancy: boolean
  jsonRpcErrorCodes: number[]
}

export function initWeb3(config: InitWeb3Params) {
  const providerOptions = {
    requestTimeout: config.rpcRequestTimeout,
    retry: RETRY_CONFIG,
  }
  config.rpcUrls.forEach(checkHTTPS(config.requireHTTPS))
  const provider = new HttpListProvider(config.rpcUrls, providerOptions, config.jsonRpcErrorCodes)
  provider.startSyncStateChecker(config.rpcSyncCheckInterval)
  web3 = new Web3(SafeEthLogsProvider(provider as HttpProvider))

  web3Redundant = web3
  if (config.relayerTxRedundancy && config.rpcUrls.length > 1) {
    const redundantProvider = new RedundantHttpListProvider(config.rpcUrls, {
      ...providerOptions,
      name: 'redundant',
    })
    web3Redundant = new Web3(redundantProvider)
  }
}
