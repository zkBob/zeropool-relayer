# Configuration

## Common configuration

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
| TX_VK_PATH | Local path to transaction curcuit verification key | string |
| STATE_DIR_PATH | Path to persistent state files related to tree and transactions storage. Default: `./state` | string |
| GAS_PRICE_FALLBACK | Default fallback gas price | integer |
| GAS_PRICE_ESTIMATION_TYPE | Gas price estimation type | `web3` / `gas-price-oracle` / `eip1559-gas-estimation` / `polygon-gasstation-v2` |
| GAS_PRICE_SPEED_TYPE | This parameter specifies the desirable transaction speed | `instant` / `fast` / `standard` / `low` |
| GAS_PRICE_FACTOR | A value that will multiply the gas price of the oracle to convert it to gwei. If the oracle API returns gas prices in gwei then this can be set to `1`. Also, it could be used to intentionally pay more gas than suggested by the oracle to guarantee the transaction verification. E.g. `1.25` or `1.5`. | integer |
| GAS_PRICE_UPDATE_INTERVAL | Interval in milliseconds used to get the updated gas price value using specified estimation type | integer |
| START_BLOCK | The block number used to start searching for events when the relayer instance is run for the first time | integer
| EVENTS_PROCESSING_BATCH_SIZE | Batch size for one `eth_getLogs` request when reprocessing old logs. Defaults to `10000` | integer
| RELAYER_LOG_LEVEL | Log level | Winston log level |
| RELAYER_REDIS_URL | Url to redis instance | URL |
| RPC_URL | Url to RPC node | URL |
| SENT_TX_DELAY | Delay in milliseconds for sentTxWorker to verify submitted transactions | integer
