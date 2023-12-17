import relayerConfig from '@/configs/relayerConfig'
import config from '@/configs/relayerConfig'
import { Pool } from '@/pool'
import { EvmBackend, Network, NetworkBackend, TronBackend } from '@/services/network'
import { Wallet } from 'ethers'

export async function init() {
  let networkBackend: NetworkBackend<Network>
  const baseConfig = {
    poolAddress: config.COMMON_POOL_ADDRESS,
    tokenAddress: config.RELAYER_TOKEN_ADDRESS,
    pk: config.RELAYER_ADDRESS_PRIVATE_KEY,
    rpcUrls: config.COMMON_RPC_URL,
    requireHTTPS: config.COMMON_REQUIRE_RPC_HTTPS,
  }
  if (config.RELAYER_NETWORK === Network.Ethereum) {
    networkBackend = new EvmBackend({
      ...baseConfig,
      rpcRequestTimeout: config.COMMON_RPC_REQUEST_TIMEOUT,
      rpcSyncCheckInterval: config.COMMON_RPC_SYNC_STATE_CHECK_INTERVAL,
      jsonRpcErrorCodes: config.COMMON_JSONRPC_ERROR_CODES,
      relayerTxRedundancy: config.RELAYER_TX_REDUNDANCY,
    })
  } else if (config.RELAYER_NETWORK === Network.Tron) {
    networkBackend = new TronBackend({
      ...baseConfig,
    })
  } else {
    throw new Error('Unsupported network backend')
  }
  await networkBackend.init()

  const pool = new Pool(networkBackend)
  await pool.init(false)

  const signer = new Wallet(relayerConfig.RELAYER_ADDRESS_PRIVATE_KEY) // TODO: config pk

  return { pool, signer }
}
