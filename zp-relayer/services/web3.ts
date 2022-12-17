import Web3 from 'web3'
import config from '@/config'
import type { HttpProvider } from 'web3-core'
import { RETRY_CONFIG } from '@/utils/constants'
import HttpListProvider from './HttpListProvider'

const providerOptions = {
  requestTimeout: config.rpcRequestTimeout,
  retry: RETRY_CONFIG,
}

const provider = new HttpListProvider(config.rpcUrl, providerOptions)
export const web3 = new Web3(provider as HttpProvider)
