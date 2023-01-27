import Web3 from 'web3'
import type { HttpProvider } from 'web3-core'
import { RETRY_CONFIG } from '@/utils/constants'
import HttpListProvider from './providers/HttpListProvider'
import { checkHTTPS } from '@/utils/helpers'
import { SafeEthLogsProvider } from './providers/SafeEthLogsProvider'
import config from '@/configs/baseConfig'

const providerOptions = {
  requestTimeout: config.rpcRequestTimeout,
  retry: RETRY_CONFIG,
}
config.rpcUrls.forEach(checkHTTPS(config.requireHTTPS))
const provider = new HttpListProvider(config.rpcUrls, providerOptions, config.jsonRpcErrorCodes)
provider.startSyncStateChecker(config.rpcSyncCheckInterval)
export const web3 = new Web3(SafeEthLogsProvider(provider as HttpProvider))
