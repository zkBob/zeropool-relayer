# Configuration

## Relayer

| name | description | value |
| - | - | - |
| PORT | Relayer port | integer |
| RELAYER_ADDRESS_PRIVATE_KEY | Private key to sign pool transactions | hexadecimal prefixed with "0x" |
| POOL_ADDRESS | Address of the pool contract | hexadecimal prefixed with "0x" |
| RELAYER_GAS_LIMIT | Gas limit for pool transactions | integer |
| RELAYER_FEE | Minimal accepted relayer fee (in tokens | integer |
| MAX_NATIVE_AMOUNT_FAUCET | Maximal amount of faucet value (in ETH) | integer |
| TREE_UPDATE_PARAMS_PATH | Local path to tree update circuit parameters | string |
| TRANSFER_PARAMS_PATH | Local path to transfer circuit parameters | string |
| TX_VK_PATH | Local path to transaction circuit verification key | string |
| RELAYER_REQUEST_LOG_PATH | Path to a file where all HTTP request logs will be saved. Default `./zp.log`. | string |
| STATE_DIR_PATH | Path to persistent state files related to tree and transactions storage. Default: `./POOL_STATE` | string |
| GAS_PRICE_FALLBACK | Default fallback gas price | integer |
| GAS_PRICE_ESTIMATION_TYPE | Gas price estimation type | `web3` / `gas-price-oracle` / `eip1559-gas-estimation` / `polygon-gasstation-v2` |
| GAS_PRICE_SPEED_TYPE | This parameter specifies the desirable transaction speed | `instant` / `fast` / `standard` / `low` |
| GAS_PRICE_FACTOR | A value that will multiply the gas price of the oracle to convert it to gwei. If the oracle API returns gas prices in gwei then this can be set to `1`. Also, it could be used to intentionally pay more gas than suggested by the oracle to guarantee the transaction verification. E.g. `1.25` or `1.5`. | integer |
| GAS_PRICE_UPDATE_INTERVAL | Interval in milliseconds used to get the updated gas price value using specified estimation type | integer |
| GAS_PRICE_SURPLUS | A surplus to be added to fetched `gasPrice` on initial transaction submission. Default `0.1`. | float |
| MIN_GAS_PRICE_BUMP_FACTOR | Minimum `gasPrice` bump factor to meet RPC node requirements. Default `0.1`. | float |
| MAX_FEE_PER_GAS_LIMIT | Max limit on `maxFeePerGas` parameter for each transaction in wei | integer |
| MAX_SENT_QUEUE_SIZE | Maximum number of jobs waiting in the `sentTxQueue` at a time. | integer |
| START_BLOCK | The block number used to start searching for events when the relayer instance is run for the first time | integer |
| EVENTS_PROCESSING_BATCH_SIZE | Batch size for one `eth_getLogs` request when reprocessing old logs. Defaults to `10000` | integer |
| RELAYER_LOG_LEVEL | Log level | Winston log level |
| REDIS_URL | Url to redis instance | URL |
| RPC_URL | The HTTPS URL(s) used to communicate to the RPC nodes. Several URLs can be specified, delimited by spaces. If the connection to one of these nodes is lost the next URL is used for connection. | URL |
| RELAYER_TX_REDUNDANCY | If set to `true`, instructs relayer to send `eth_sendRawTransaction` requests through all available RPC urls defined in `RPC_URL` variables instead of using first available one. Defaults to `false` | boolean |
| RELAYER_RPC_SYNC_STATE_CHECK_INTERVAL | Interval in milliseconds for checking JSON RPC sync state, by requesting the latest block number. Relayer will switch to the fallback JSON RPC in case sync process is stuck. If this variable is `0` sync state check is disabled. Defaults to `0`  | integer |
| RELAYER_JSONRPC_ERROR_CODES | Override default JSON rpc error codes that can trigger RPC fallback to the next URL from the list (or a retry in case of a single RPC URL). Default is `-32603,-32002,-32005`. Should be a comma-separated list of negative integers. | `string`
| INSUFFICIENT_BALANCE_CHECK_TIMEOUT | Interval in milliseconds to check for relayer balance update if transaction send failed with insufficient balance error. Default `60000` | integer |
| RPC_REQUEST_TIMEOUT | Timeout in milliseconds for a single RPC request. Defaults to `1000`. | integer |
| SENT_TX_DELAY | Delay in milliseconds for sentTxWorker to verify submitted transactions | integer |
| SENT_TX_ERROR_THRESHOLD | Maximum number of re-sends which is considered to be normal. After this threshold each re-send will log a corresponding error (but re-send loop will continue). Defaults to `3`. | integer |
| PERMIT_DEADLINE_THRESHOLD_INITIAL | Minimum time threshold in seconds for permit signature deadline to be valid (before initial transaction submission) | integer |
| PERMIT_DEADLINE_THRESHOLD_RESEND | Minimum time threshold in seconds for permit signature deadline to be valid (for re-send attempts) | integer |
| RELAYER_REQUIRE_TRACE_ID | If set to `true`, then requests to relayer (except `/info`, `/version`, `/params/hash/tree`, `/params/hash/tx`) without `zkbob-support-id` header will be rejected. | boolean |
| RELAYER_REQUIRE_HTTPS | If set to `true`, then RPC URL(s) must be in HTTPS format. HTTP RPC URL(s) should be used in test environment only. | boolean |
| RELAYER_LOG_IGNORE_ROUTES | List of space separated relayer endpoints for which request logging will be suppressed. E.g. `/fee /version` | string(s) |
| RELAYER_LOG_HEADER_BLACKLIST | List of space separated HTTP headers which will be suppressed in request logs. E.g. `content-length content-type` | string(s) |
| RELAYER_SCREENER_URL | Screener service URL | URL |
| RELAYER_SCREENER_TOKEN | Authorization token for screener service | string |

## Watcher

| name | description | value |
| - | - | - |
| WATCHER_LOG_LEVEL | Log level | Winston log level |
| POOL_ADDRESS | Address of the pool contract | hexadecimal prefixed with "0x" |
| START_BLOCK | The block number used to start searching for events when the watcher instance is run for the first time | integer |
| REDIS_URL | Url to redis instance | URL |
| RPC_URL | The HTTPS URL(s) used to communicate to the RPC nodes. Several URLs can be specified, delimited by spaces. If the connection to one of these nodes is lost the next URL is used for connection. | URL |
| WATCHER_JSONRPC_ERROR_CODES | Override default JSON rpc error codes that can trigger RPC fallback to the next URL from the list (or a retry in case of a single RPC URL). Default is `-32603,-32002,-32005`. Should be a comma-separated list of negative integers. | `string`
| BLOCK_CONFIRMATIONS | Number of required block confirmations to process direct deposit events. | integer |
| WATCHER_REQUIRE_HTTPS | If set to `true`, then RPC URL(s) must be in HTTPS format. HTTP RPC URL(s) should be used in test environment only. | boolean |
| WATCHER_RPC_SYNC_STATE_CHECK_INTERVAL | Interval in milliseconds for checking JSON RPC sync state, by requesting the latest block number. Watcher will switch to the fallback JSON RPC in case sync process is stuck. If this variable is `0` sync state check is disabled. Defaults to `0`.  | integer |
| RPC_REQUEST_TIMEOUT | Timeout in milliseconds for a single RPC request. Defaults to `1000`. | integer |
| EVENTS_PROCESSING_BATCH_SIZE | Batch size for one `eth_getLogs` request. Defaults to `10000`. | integer |
| WATCHER_EVENT_POLLING_INTERVAL | The interval in milliseconds used to request the RPC node for new blocks. | integer |
| DIRECT_DEPOSIT_BATCH_SIZE | Maximum size of a single direct deposit batch. Defaults to `16`. | integer |
| DIRECT_DEPOSIT_BATCH_TTL | Maximum TTL in milliseconds for a new direct deposit batch. After this time batch will be submitted to the queue, even if it has less than `DIRECT_DEPOSIT_BATCH_SIZE` elements. Defaults to `3600000` (1 hour) | integer |
