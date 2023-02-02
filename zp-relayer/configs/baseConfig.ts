const config = {
  poolAddress: process.env.COMMON_POOL_ADDRESS as string,
  startBlock: parseInt(process.env.COMMON_START_BLOCK || '0'),
  logLevel: process.env.COMMON_LOG_LEVEL || 'debug',
  redisUrl: process.env.COMMON_REDIS_URL as string,
  rpcUrls: (process.env.COMMON_RPC_URL as string).split(' ').filter(url => url.length > 0),
  requireHTTPS: process.env.COMMON_REQUIRE_RPC_HTTPS === 'true',
  rpcSyncCheckInterval: parseInt(process.env.COMMON_RPC_SYNC_STATE_CHECK_INTERVAL || '0'),
  rpcRequestTimeout: parseInt(process.env.COMMON_RPC_REQUEST_TIMEOUT || '1000'),
  jsonRpcErrorCodes: (process.env.COMMON_JSONRPC_ERROR_CODES || '-32603 -32002 -32005')
    .split(' ')
    .filter(s => s.length > 0)
    .map(s => parseInt(s, 10)),
  eventsProcessingBatchSize: parseInt(process.env.COMMON_EVENTS_PROCESSING_BATCH_SIZE || '10000'),
  screenerUrl: process.env.COMMON_SCREENER_URL || null,
  screenerToken: process.env.COMMON_SCREENER_TOKEN || null,
}

export default config
