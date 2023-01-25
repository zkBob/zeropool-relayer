const config = {
  logLevel: process.env.WATCHER_LOG_LEVEL || 'debug',
  poolAddress: process.env.POOL_ADDRESS as string,
  startBlock: parseInt(process.env.START_BLOCK || '0'),

  redisUrl: process.env.REDIS_URL as string,
  rpcUrls: (process.env.RPC_URL as string).split(' ').filter(url => url.length > 0),

  blockConfirmations: parseInt(process.env.BLOCK_CONFIRMATIONS || '128'),

  requireHTTPS: process.env.WATCHER_REQUIRE_HTTPS === 'true',
  rpcSyncCheckInterval: parseInt(process.env.WATCHER_RPC_SYNC_STATE_CHECK_INTERVAL || '0'),
  rpcRequestTimeout: parseInt(process.env.RPC_REQUEST_TIMEOUT || '1000'),
  jsonRpcErrorCodes: (process.env.WATCHER_JSONRPC_ERROR_CODES || '-32603 -32002 -32005')
    .split(' ')
    .filter(s => s.length > 0)
    .map(s => parseInt(s, 10)),

  eventsProcessingBatchSize: parseInt(process.env.EVENTS_PROCESSING_BATCH_SIZE || '10000'),
  eventPollingInterval: parseInt(process.env.WATCHER_EVENT_POLLING_INTERVAL || '600000'),
  directDepositBatchSize: parseInt(process.env.DIRECT_DEPOSIT_BATCH_SIZE || '16'),
  directDepositBatchTtl: parseInt(process.env.DIRECT_DEPOSIT_BATCH_TTL || '3600000'),
}

export default config
