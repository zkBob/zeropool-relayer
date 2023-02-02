import baseConfig from './baseConfig'

const config = {
  ...baseConfig,
  eventPollingInterval: parseInt(process.env.WATCHER_EVENT_POLLING_INTERVAL || '600000'),
  directDepositBatchSize: parseInt(process.env.DIRECT_DEPOSIT_BATCH_SIZE || '16'),
  directDepositBatchTtl: parseInt(process.env.DIRECT_DEPOSIT_BATCH_TTL || '3600000'),
}

export default config
