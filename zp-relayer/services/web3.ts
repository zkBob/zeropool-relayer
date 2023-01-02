import Web3 from 'web3'
import config from '@/config'
import type { HttpProvider } from 'web3-core'
import { RETRY_CONFIG } from '@/utils/constants'
import HttpListProvider from './providers/HttpListProvider'
import RedundantHttpListProvider from './providers/RedundantHttpListProvider'
import { checkHTTPS } from '@/utils/helpers'

const providerOptions = {
  requestTimeout: config.rpcRequestTimeout,
  retry: RETRY_CONFIG,
}

config.rpcUrls.forEach(checkHTTPS(config.requireHTTPS))
const provider = new HttpListProvider(config.rpcUrls, providerOptions)
const web3 = new Web3(provider as HttpProvider)

let web3Redundant = web3
if (config.relayerTxRedundancy && config.rpcUrls.length > 1) {
  const redundantProvider = new RedundantHttpListProvider(config.rpcUrls, {
    ...providerOptions,
    name: 'redundant',
  })
  web3Redundant = new Web3(redundantProvider)
}

export { web3, web3Redundant }
