# Relayer for ZkBob application

Relayers primary role is to deliver user-prepared ZkBob transactions to the private pool contract. Also, it can be used as cache service to conveniently retrieve information about previous transactions, current Merkle Tree state, transaction fees, etc.

## How to start locally

**Docker:**
You can use a pre-built [image](https://github.com/zkBob/zeropool-relayer/releases) from registry. List of env configuration parameters can be found in `zp-relayer/.env.example`.
## Tests

**Unit tests:**
```bash
cd zp-relayer && yarn test:unit
```


## Workflow

*High-level overview*:

1. Client fetches all commitments and memo blocks (either from relayer or directly from the blockchain) and decrypts their notes and accounts. All commitments should be stored in local Merkle tree, together with found notes and accounts.
2. Client builds a zk-SNARK proof for the transaction using previously fetched notes and the most recent account. This proof, together with public inputs, memo block, and optional nullifier signature (used only for deposits), is sent to the relayer.
3. Relayer adds a job to the queue. It checks that the tx proof is valid, builds another zk-SNARK proof for tree update, sends tx to the blockchain, and updates the local Merkle tree using sent data. It also locally stores commitment hash (one of the public inputs) and memo messages.

You can use already implemented [client](https://github.com/zkBob/zkbob-client-js) to check for details.


```mermaid
sequenceDiagram
    actor U as User
    participant R as Relayer
    participant P as Private pool
    U->>R: /transactions/v2
    R->>U: transaction batch
    Note Over U: Update Merkle Tree
    Note Over U: Build ZK proof
    U->>R: /sendTransactions
    Note Over R: Validate transactions
    Note Over R: Add transactions to <br /> optimistic state
    R->>P: Submit transactions
    R->>U: jobId
    loop Until mined
        Note Over R: Check if transaction <br /> is mined
        Note Over R: Update gasPrice
        R->>P: Re-submit transaction
    end
    Note Over R: Update confirmed state
    par Wait for transaction
        U->>R: /job/:jobId
        R->>U: job status
    and Update local state
        U->>R: /transactions/v2
        R->>U: transaction batch
    end
```


## API

For a detailed description of each method's payload you can refer to `/validation/validation.ts` file with JSON validation schemas.

`/sendTransaction` - submit a transaction to relayer (deprecated).
`/sendTransactions` - submit batch of transaction to relayer.
`/transactions?limit=${limit}&offset=${offset}&optimistic=${true|false}` - list of transaction memo blocks (deprecated)
`/transactions/v2?limit=${limit}&offset=${offset}` - list of encoded transactions data in the following format `"${stateBit}${txHash}${outCommit}${memo}"`. `stateBit` is `1` if transaction is in confirmed state and `0` otherwise.
`/merkle/root/:index?` - get Merkle Tree root at specified index.
`/job/:id` - information about user's job state
**Response**
```
{
    resolvedJobId // Resolved job id as job can be re-tried several times
    createdOn
    failedReason
    finishedOn
    state
    txHash
}
```
`/info` - information about current pool state.
**Response**
```
{
    root // Confirmed tree root
    optimisticRoot // Optimistic tree root
    deltaIndex // Confirmed tree root index
    optimisticDeltaIndex // Optimistic tree root index
}
```
`/fee` - current relayer fee.
**Response**
```
{
    fee // Fee in pool tokens
}
```
`/limits?address=${ethAddress}` - current pool limits.
**Response**
```
{
    deposit: {
        singleOperation // Limit for single pool operation
        daylyForAddress: { // Daily deposit limits for address
          total
          available
        },
        daylyForAll: { // Daily deposit limits  for all users
          total
          available
        },
        poolLimit: { // Daily pool limit
          total 
          available
        },
    },
    withdraw: {
        daylyForAll: { // Daily withdraw limit for all users
          total
          available
        },
    },
    tier // Address tier
}
```
`/params/hash/tree` - hash of pool tree proving parameters.
`/params/hash/tx` - hash of pool transaction proving parameters.
