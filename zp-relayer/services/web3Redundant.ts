import Web3 from 'web3'
import RedundantHttpListProvider from './providers/RedundantHttpListProvider'
import config from '@/configs/relayerConfig'
import { web3 } from './web3'
import { RETRY_CONFIG } from '@/utils/constants'

export let web3Redundant = web3

const providerOptions = {
  requestTimeout: config.rpcRequestTimeout,
  retry: RETRY_CONFIG,
}
if (config.relayerTxRedundancy && config.rpcUrls.length > 1) {
  const redundantProvider = new RedundantHttpListProvider(config.rpcUrls, {
    ...providerOptions,
    name: 'redundant',
  })
  web3Redundant = new Web3(redundantProvider)
}
