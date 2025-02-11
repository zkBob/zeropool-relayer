import config from '@/configs/relayerConfig'
import { logger } from '@/lib/appLogger'
import { Network } from '@/lib/network'
import { redis } from '@/lib/redisClient'
import { JobState, PoolTx, poolTxQueue, TxPayload, WorkerTxType } from '@/queue/poolTxQueue'
import { TxStore } from '@/state/TxStore'
import { ENERGY_SIZE, MOCK_CALLDATA, OUTPLUSONE, PERMIT2_CONTRACT, TOKEN_SIZE, TRANSFER_INDEX_SIZE } from '@/utils/constants'
import {
  applyDenominator,
  buildPrefixedMemo,
  encodeProof,
  fetchJson,
  numToHex,
  sleep,
  truncateHexPrefix,
  truncateMemoTxPrefixProverV2,
} from '@/utils/helpers'
import { Permit2Recover, SaltedPermitRecover, TransferWithAuthorizationRecover } from '@/utils/permit'
import { PermitType, type PermitRecover } from '@/utils/permit/types'
import { getTxProofField, parseDelta } from '@/utils/proofInputs'
import {
  checkAddressEq,
  checkAssertion,
  checkCondition,
  checkDeadline,
  checkDepositEnoughBalance,
  checkFee,
  checkLimits,
  checkMemoPrefixProverV2,
  checkNativeAmount,
  checkNonZeroWithdrawAddress,
  checkNullifier,
  checkNullifierContract,
  checkPoolId,
  checkProof,
  checkRootIndexer,
  checkScreener,
  checkTransferIndex,
  getRecoveredAddress,
  TxValidationError,
} from '@/validation/tx/common'
import AbiCoder from 'web3-eth-abi'
import { bytesToHex, toBN } from 'web3-utils'
import { getTxDataProverV2, TxDataProverV2, TxType } from 'zp-memo-parser'
import { BasePool } from './BasePool'
import { OptionalChecks, PermitConfig, ProcessResult } from './types'
import BigNumber from 'bignumber.js'

const ZERO = toBN(0)

export class RelayPool extends BasePool<Network> {
  public permitRecover: PermitRecover | null = null
  private proxyAddress!: string
  private indexerUrl!: string
  private observePromise: Promise<void> | undefined;
  txStore!: TxStore

  protected poolName(): string { return 'relay-pool'; }

  async init(permitConfig: PermitConfig, proxyAddress: string, indexerUrl: string) {
    if (this.isInitialized) return

    this.txStore = new TxStore('tmp-tx-store', redis)

    this.proxyAddress = proxyAddress
    this.indexerUrl = indexerUrl

    this.denominator = toBN(await this.network.pool.call('denominator'))
    this.poolId = toBN(await this.network.pool.call('pool_id'))

    if (permitConfig.permitType === PermitType.SaltedPermit) {
      this.permitRecover = new SaltedPermitRecover(this.network, permitConfig.token)
    } else if (permitConfig.permitType === PermitType.Permit2) {
      this.permitRecover = new Permit2Recover(this.network, PERMIT2_CONTRACT)
    } else if (permitConfig.permitType === PermitType.TransferWithAuthorization) {
      this.permitRecover = new TransferWithAuthorizationRecover(this.network, permitConfig.token)
    } else if (permitConfig.permitType === PermitType.None) {
      this.permitRecover = null
    } else {
      throw new Error("Cannot infer pool's permit standard")
    }
    await this.permitRecover?.initializeDomain()

    this.isInitialized = true

    this.observePromise = undefined;
  }

  async validateTx(
    { transaction: { memo, proof, txType, depositSignature } }: PoolTx<WorkerTxType.Normal>,
    optionalChecks: OptionalChecks = {},
    traceId?: string
  ): Promise<void> {
    // Additional checks for memo?
    await checkAssertion(() => checkMemoPrefixProverV2(memo, txType))

    const buf = Buffer.from(memo, 'hex')
    const txData = getTxDataProverV2(buf, txType)

    const root = getTxProofField(proof, 'root')
    const nullifier = getTxProofField(proof, 'nullifier')
    const delta = parseDelta(getTxProofField(proof, 'delta'))
    const transactFee = toBN(txData.transactFee)
    const treeUpdateFee = toBN(txData.treeUpdateFee)
    const proxyAddress = bytesToHex(Array.from(txData.proxyAddress))
    const proverAddress = bytesToHex(Array.from(txData.proverAddress))

    logger.info('TxData', {
      deltaTokens: delta.tokenAmount.toString(10),
      deltaEnergy: delta.energyAmount.toString(10),
      transactFee: transactFee.toString(10),
      treeUpdateFee: treeUpdateFee.toString(10),
      proxyAddress,
      proverAddress,
    })

    const indexerInfo = await this.getIndexerInfo()

    await checkAssertion(() => checkAddressEq(proxyAddress, this.proxyAddress))
    await checkAssertion(() => checkPoolId(delta.poolId, this.poolId))
    await checkAssertion(() => checkRootIndexer(delta.transferIndex, root, this.indexerUrl))
    await checkAssertion(() => checkNullifier(nullifier, this.optimisticState.nullifiers))
    await checkAssertion(() => checkNullifierContract(nullifier, this.network))
    await checkAssertion(() => checkTransferIndex(toBN(indexerInfo.optimisticDeltaIndex), delta.transferIndex))
    await checkAssertion(() => checkProof(proof, (p, i) => this.verifyProof(p, i)))

    const tokenAmount = delta.tokenAmount
    const totalFee = transactFee.add(treeUpdateFee)
    const tokenAmountWithFee = tokenAmount.add(totalFee)
    const energyAmount = delta.energyAmount

    let nativeConvert = false
    let userAddress: string

    if (txType === TxType.WITHDRAWAL) {
      checkCondition(tokenAmountWithFee.lte(ZERO) && energyAmount.lte(ZERO), 'Incorrect withdraw amounts')

      const { nativeAmount, receiver } = txData as TxDataProverV2<TxType.WITHDRAWAL>
      const nativeAmountBN = toBN(nativeAmount)
      userAddress = bytesToHex(Array.from(receiver))
      logger.info('Withdraw address: %s', userAddress)
      await checkAssertion(() => checkNonZeroWithdrawAddress(userAddress))
      await checkAssertion(() =>
        checkNativeAmount(nativeAmountBN, tokenAmountWithFee.neg(), config.RELAYER_MAX_NATIVE_AMOUNT)
      )

      if (!nativeAmountBN.isZero()) {
        nativeConvert = true
      }
    } else if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT) {
      checkCondition(tokenAmount.gt(ZERO) && energyAmount.eq(ZERO), 'Incorrect deposit amounts')
      checkCondition(depositSignature !== null, 'Deposit signature is required')

      const requiredTokenAmount = applyDenominator(tokenAmountWithFee, this.denominator)
      userAddress = await getRecoveredAddress(
        txType,
        nullifier,
        txData,
        this.network,
        requiredTokenAmount,
        depositSignature as string,
        this.permitRecover
      )
      logger.info('Deposit address: %s', userAddress)
      // TODO check for approve in case of deposit
      await checkAssertion(() => checkDepositEnoughBalance(this.network, userAddress, requiredTokenAmount))
    } else if (txType === TxType.TRANSFER) {
      userAddress = this.proxyAddress
      checkCondition(tokenAmountWithFee.eq(ZERO) && energyAmount.eq(ZERO), 'Incorrect transfer amounts')
    } else {
      throw new TxValidationError('Unsupported TxType')
    }

    if (optionalChecks.fee) {
      const { feeManager } = optionalChecks.fee
      const requiredFee = await feeManager.estimateFee({
        txType,
        nativeConvert,
        txData: MOCK_CALLDATA + memo + (depositSignature || ''),
      })
      const denominatedFee = requiredFee.denominate(this.denominator).getEstimate()
      await checkAssertion(() => checkFee(totalFee, denominatedFee))
    }

    const limits = await this.getLimitsFor(userAddress)
    await checkAssertion(() => checkLimits(limits, delta.tokenAmount))

    if (txType === TxType.PERMITTABLE_DEPOSIT) {
      const { deadline } = txData as TxDataProverV2<TxType.PERMITTABLE_DEPOSIT>
      logger.info('Deadline: %s', deadline)
      await checkAssertion(() => checkDeadline(toBN(deadline), config.RELAYER_PERMIT_DEADLINE_THRESHOLD_INITIAL))
    }

    if (txType === TxType.DEPOSIT || txType === TxType.PERMITTABLE_DEPOSIT || txType === TxType.WITHDRAWAL) {
      if (optionalChecks.screener) {
        const { screenerUrl, screenerToken } = optionalChecks.screener
        await checkAssertion(() => checkScreener(userAddress, screenerUrl, screenerToken, traceId))
      }
    }
  }

  async buildNormalTx({
    transaction: { proof, memo, depositSignature, txType },
  }: PoolTx<WorkerTxType.Normal>): Promise<ProcessResult<RelayPool>> {
    const func = 'transactV2()'
    const version = 2

    const nullifier = getTxProofField(proof, 'nullifier')
    const outCommit = getTxProofField(proof, 'out_commit')
    const delta = parseDelta(getTxProofField(proof, 'delta'))

    const selector: string = AbiCoder.encodeFunctionSignature(func)

    let transferIndex = numToHex(delta.transferIndex, TRANSFER_INDEX_SIZE)
    let energyAmount = numToHex(delta.energyAmount, ENERGY_SIZE)
    let tokenAmount = numToHex(delta.tokenAmount, TOKEN_SIZE)

    const txFlatProof = encodeProof(proof.proof)

    const memoSize = numToHex(toBN(memo.length).divn(2), 4)

    const data = [
      selector,
      numToHex(toBN(version), 2),
      numToHex(toBN(nullifier)),
      numToHex(toBN(outCommit)),
      transferIndex,
      energyAmount,
      tokenAmount,
      txFlatProof,
      txType,
      memoSize,
      memo,
    ]

    if (depositSignature) {
      const signature = truncateHexPrefix(depositSignature)
      data.push(signature)
    }

    const calldata = data.join('')

    const memoTruncated = truncateMemoTxPrefixProverV2(memo, txType)

    // Commit index should be treated as an optimistic checkpoint
    // It can increase after the transaction is included into the Merkle tree
    const commitIndex = await this.assumeNextPendingTxIndex();

    return {
      data: calldata,
      func,
      outCommit,
      nullifier,
      memo: memoTruncated,
      commitIndex,
    }
  }

  async onSend({ outCommit, nullifier, memo, commitIndex }: ProcessResult<RelayPool>, txHash: string): Promise<void> {
    if (nullifier) {
      logger.debug('Adding nullifier %s to OS', nullifier)
      await this.optimisticState.nullifiers.add([nullifier])
    }

    // cache transaction locally
    const indexerOptimisticIndex = Number((await this.getIndexerInfo()).deltaIndex);
    await this.cacheTxLocally(outCommit, txHash, memo, Date.now());
    // start monitoring local cache against the indexer to cleanup already indexed txs
    this.startLocalCacheObserver(indexerOptimisticIndex);
  }

  async onConfirmed(res: ProcessResult<RelayPool>, txHash: string, callback?: () => Promise<void>, jobId?: string): Promise<void> {
    logger.debug("Updating pool job %s completed, txHash %s", jobId, txHash);
    if (jobId) {
      const poolJob = await poolTxQueue.getJob(jobId);
      if (!poolJob) {
        logger.error('Pool job not found', { jobId });
      } else {
        poolJob.data.transaction.state = JobState.COMPLETED;
        poolJob.data.transaction.txHash = txHash;
        await poolJob.update(poolJob.data);
      }
    }
  }

  async onFailed(txHash: string, jobId: string): Promise<void> {
    super.onFailed(txHash, jobId);
    const poolJob = await poolTxQueue.getJob(jobId);
    if (!poolJob) {
      logger.error('Pool job not found', { jobId });
    } else {
      poolJob.data.transaction.state = JobState.REVERTED;
      poolJob.data.transaction.txHash = txHash;

      const txPayload = poolJob.data.transaction as TxPayload;
      if (txPayload.proof.inputs.length > 2) {
        const commit = txPayload.proof.inputs[2];
        this.txStore.remove(commit);
        logger.info('Removing local cached transaction', {commit});
      }
      await poolJob.update(poolJob.data);
    }
  }

  protected async cacheTxLocally(commit: string, txHash: string, memo: string, timestamp: number) {
    // store or updating local tx store
    // (we should keep sent transaction until the indexer grab them)
    const prefixedMemo = buildPrefixedMemo(
      commit,
      txHash,
      memo
    );
    await this.txStore.add(commit, prefixedMemo, timestamp);
    logger.info('Tx has been CACHED locally', { commit, timestamp });
  }

  private async getIndexerInfo() {
    const info = await fetchJson(this.indexerUrl, '/info', [])
    return info
  }

  // It's just an assumption needed for internal purposes. The final index may be changed
  private async assumeNextPendingTxIndex() {
    const [indexerInfo, localCache] = await Promise.all([this.getIndexerInfo(), this.txStore.getAll()]);
    
    return Number(indexerInfo.optimisticDeltaIndex + Object.keys(localCache).length * OUTPLUSONE);
  }

  private async getIndexerTxs(offset: number, limit: number): Promise<string[]> {
    const url = new URL('/transactions/v2', config.base.COMMON_INDEXER_URL)
    url.searchParams.set('limit', limit.toString())
    url.searchParams.set('offset', offset.toString())

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to fetch transactions from indexer. Status: ${response.status}`)
    }
    return response.json() as Promise<string[]>;
  }

  // observe the current local cache and indexer to remove local record
  // after adding it to the indexer's optimistic/persistent state
  // return when local cache is empty
  protected async startLocalCacheObserver(fromIndex: number): Promise<void> {
    if (this.observePromise == undefined) {
      this.observePromise = this.localCacheObserverWorker(fromIndex).finally(() => {
        this.observePromise = undefined;
      });
    }

    return this.observePromise;
  }

  protected async localCacheObserverWorker(fromIndex: number): Promise<void> {
    // we start checking transactions slightly earlier than the current optimistic index
    // to cover the case when the indexer was already updated before onSend was called
    const OFFSET_MARGIN = 10 * OUTPLUSONE;
    fromIndex = Math.max(fromIndex - OFFSET_MARGIN, 0);
    logger.debug('Local cache observer worker was started', { fromIndex })
    const CACHE_OBSERVE_INTERVAL_MS = 1000; // waiting time between checks
    const EXTEND_LIMIT_TO_FETCH = 10; // taking into account non-atomic nature of /info and /transactions/v2 requests
    const EXPIRATION_MS = 1000 * 60 * 60 * 24; // we drop entries older than 24 hours, unlikely that they ever will be indexed
    
    while (true) {
      const localEntries = Object.entries(await this.txStore.getAll());
      let localEntriesCnt = localEntries.length;

      if (localEntries.length == 0) {
        break;
      }

      // there are entries in the local cache
      try {
        const indexerOptimisticIndex = Number((await this.getIndexerInfo()).optimisticDeltaIndex);
        const limit = (indexerOptimisticIndex - fromIndex) / OUTPLUSONE + localEntries.length + EXTEND_LIMIT_TO_FETCH;
        const indexerCommitments = (await this.getIndexerTxs(fromIndex, limit)).map(tx => BigNumber(tx.slice(65, 129), 16).toString(10));

        // find cached commitments in the indexer's response
        for (const [commit, {memo, timestamp}] of localEntries) {
          if (indexerCommitments.includes(commit)) {
            logger.info('Deleting cached entry', { commit, timestamp })
            await this.txStore.remove(commit)
            localEntriesCnt--;
          } else {
            if (Date.now() - timestamp > EXPIRATION_MS) {
              logger.error('Cached transaction was not indexed for a long time, removing', { commit, timestamp });
              await this.txStore.remove(commit)
              localEntriesCnt--;
            }
            //logger.info('Cached entry is still in the local cache', { commit, index });
          }
        }
      } catch(e) {
        logger.error(`Cannot check local cache against indexer : ${(e as Error).message}`);
      }

      if (localEntriesCnt > 0) {
        await sleep(CACHE_OBSERVE_INTERVAL_MS);
      }
    }

    logger.debug('Local cache observer worker has finished', { fromIndex })
  }
}
