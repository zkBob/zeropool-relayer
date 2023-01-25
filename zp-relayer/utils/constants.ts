import { Constants } from 'libzkbob-rs-node'

const constants = {
  FALLBACK_RPC_URL_SWITCH_TIMEOUT: 60 * 60 * 1000,
  TX_QUEUE_NAME: 'tx',
  SENT_TX_QUEUE_NAME: 'sent',
  DIRECT_DEPOSIT_QUEUE_NAME: 'direct-deposit',
  OUTPLUSONE: Constants.OUT + 1,
  TRANSFER_INDEX_SIZE: 12,
  ENERGY_SIZE: 28,
  TOKEN_SIZE: 16,
  POOL_ID_SIZE: 6,
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
  INIT_ROOT: '11469701942666298368112882412133877458305516134926649826543144744382391691533',
  RETRY_CONFIG: {
    retries: 2,
    factor: 1.4,
    maxTimeout: 60000,
    randomize: true,
  },
  TRACE_ID: 'zkbob-support-id' as const,
}

export = constants
