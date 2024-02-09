import { logger } from '@/services/appLogger'
import {
  addExtraGasPrice,
  chooseGasPriceOptions,
  EstimationType,
  GasPrice,
  GasPriceValue,
  getGasPriceValue,
} from '@/services/gas-price'
import {
  SendError,
  type PreparedTx,
  type SendAttempt,
  type SendTx,
  type TransactionManager,
  type TxInfo,
} from '@/services/network/types'
import { readNonce, updateNonce } from '@/utils/redisFields'
import { getChainId } from '@/utils/web3'
import { isGasPriceError, isInsufficientBalanceError, isNonceError, isSameTransactionError } from '@/utils/web3Errors'
import { Mutex } from 'async-mutex'
import BN from 'bn.js'
import type { Redis } from 'ioredis'
import Web3 from 'web3'
import type { TransactionConfig } from 'web3-core'
import { Logger } from 'winston'

export interface EvmTxManagerConfig {
  redis: Redis
  gasPriceBumpFactor: number
  gasPriceSurplus: number
  gasPriceMaxFeeLimit: BN | null
}

type ExtraInfo = TransactionConfig

export class EvmTxManager implements TransactionManager<ExtraInfo> {
  nonce!: number
  chainId!: number
  mutex: Mutex
  logger!: Logger
  address: string

  constructor(
    private web3: Web3,
    private pk: string,
    public gasPrice: GasPrice<EstimationType>,
    private config: EvmTxManagerConfig
  ) {
    this.mutex = new Mutex()
    this.address = new Web3().eth.accounts.privateKeyToAccount(pk).address
  }

  async init() {
    this.nonce = await readNonce(this.config.redis, this.web3, this.address)(true)
    await updateNonce(this.config.redis, this.nonce)
    this.chainId = await getChainId(this.web3)
  }

  async updateAndBumpGasPrice(
    txConfig: TransactionConfig,
    newGasPrice: GasPriceValue
  ): Promise<[GasPriceValue | null, GasPriceValue]> {
    const oldGasPrice = getGasPriceValue(txConfig)
    if (oldGasPrice) {
      const oldGasPriceWithExtra = addExtraGasPrice(oldGasPrice, this.config.gasPriceBumpFactor, null)
      return [oldGasPrice, chooseGasPriceOptions(oldGasPriceWithExtra, newGasPrice)]
    } else {
      return [null, newGasPrice]
    }
  }

  async prepareTx({ txDesc, options, extraData }: SendTx<ExtraInfo>): Promise<[PreparedTx, SendAttempt<ExtraInfo>]> {
    const txConfig = {
      ...txDesc,
      ...extraData,
      gas: extraData?.gas,
    }

    const release = await this.mutex.acquire()
    try {
      const gasPriceValue = options.shouldUpdateGasPrice ? await this.gasPrice.fetchOnce() : this.gasPrice.getPrice()
      const newGasPriceWithExtra = addExtraGasPrice(
        gasPriceValue,
        this.config.gasPriceSurplus,
        this.config.gasPriceMaxFeeLimit
      )

      let updatedTxConfig: TransactionConfig = {}
      let newGasPrice: GasPriceValue

      if (options.isResend) {
        if (typeof txConfig.nonce === 'undefined') {
          throw new Error('Nonce should be set for re-send')
        }
        const [oldGasPrice, updatedGasPrice] = await this.updateAndBumpGasPrice(txConfig, newGasPriceWithExtra)
        newGasPrice = updatedGasPrice
        logger.info('Updating tx gasPrice: %o -> %o', oldGasPrice, newGasPrice)
      } else {
        logger.info('Nonce', { nonce: this.nonce })
        newGasPrice = newGasPriceWithExtra
        updatedTxConfig.nonce = this.nonce++
        updatedTxConfig.chainId = this.chainId
        await updateNonce(this.config.redis, this.nonce)
      }

      updatedTxConfig = {
        ...updatedTxConfig,
        ...txConfig,
        ...newGasPrice,
      }

      const { transactionHash, rawTransaction } = await this.web3.eth.accounts.signTransaction(updatedTxConfig, this.pk)
      return [
        {
          rawTransaction: rawTransaction as string,
        },
        {
          txHash: transactionHash as string,
          extraData: updatedTxConfig,
        },
      ]
    } finally {
      release()
    }
  }

  async resendTx(prevAttempts: SendAttempt<ExtraInfo>[]) {
    if (prevAttempts.length === 0) {
      throw new Error('No previous attempts')
    }

    const { txHash, extraData } = prevAttempts.at(-1)!
    logger.info('Resending tx %s ', txHash)

    const preparedTx = await this.prepareTx({
      txDesc: {
        to: extraData.to as string,
        value: extraData.value as number,
        data: extraData.data as string,
      },
      extraData,
      options: {
        isResend: true,
        shouldUpdateGasPrice: true,
      },
    })

    try {
      await new Promise((res, rej) =>
        // prettier-ignore
        this.web3.eth.sendSignedTransaction(preparedTx[0].rawTransaction)
        .once('transactionHash', () => res(preparedTx))
        .once('error', e => {
          // Consider 'already known' errors as a successful send
          if (isSameTransactionError(e)){
            res(preparedTx)
          } else {
            rej(e)
          }
        })
      )
      return {
        attempt: preparedTx[1],
      }
    } catch (e) {
      const err = e as Error
      // jobLogger.warn('Tx resend failed', { error: err.message, txHash })
      if (isGasPriceError(err) || isSameTransactionError(err)) {
        // Tx wasn't sent successfully, but still update last attempt's
        // gasPrice to be accounted in the next iteration
        return {
          attempt: preparedTx[1],
          error: SendError.GAS_PRICE_ERROR,
        }
        // await job.update({
        //   ...job.data,
        // })
      } else if (isInsufficientBalanceError(err)) {
        return {
          attempt: preparedTx[1],
          error: SendError.INSUFFICIENT_BALANCE,
        }
        // We don't want to take into account last gasPrice increase
        // job.data.prevAttempts.at(-1)![1] = lastGasPrice

        // const minimumBalance = toBN(txConfig.gas!).mul(toBN(getMaxRequiredGasPrice(gasPrice)))
        // jobLogger.error('Insufficient balance, waiting for funds', { minimumBalance: minimumBalance.toString(10) })
      } else if (isNonceError(err)) {
        return {
          attempt: preparedTx[1],
          error: SendError.NONCE_ERROR,
        }
        // jobLogger.warn('Nonce error', { error: err.message, txHash })
        // // Throw suppressed error to be treated as a warning
        // throw new Error(RECHECK_ERROR)
      }
    }

    return {
      attempt: preparedTx[1],
      error: SendError.GAS_PRICE_ERROR,
    }
  }

  async confirmTx(txHashes: string[]): Promise<[TxInfo | null, boolean]> {
    // Transaction was not mined
    // const actualNonce = await getNonce(this.web3, this.address)
    // logger.info('Nonce value from RPC: %d; tx nonce: %d', actualNonce, txNonce)
    // if (actualNonce <= txNonce) {
    //   return null
    // }

    let tx = null
    // Iterate in reverse order to check the latest hash first
    for (let i = txHashes.length - 1; i >= 0; i--) {
      const txHash = txHashes[i]
      logger.info('Verifying tx', { txHash })
      try {
        tx = await this.web3.eth.getTransactionReceipt(txHash)
      } catch (e) {
        logger.warn('Cannot get tx receipt; RPC response: %s', (e as Error).message, { txHash })
        // Exception should be caught by `withLoop` to re-run job
        throw e
      }
      if (tx && tx.blockNumber)
        return [{ txHash: tx.transactionHash, success: tx.status, blockNumber: tx.blockNumber }, false]
    }
    return [null, false]
  }

  async _sendTx(rawTransaction: string): Promise<void> {
    return new Promise((res, rej) =>
      // prettier-ignore
      this.web3.eth.sendSignedTransaction(rawTransaction)
        .once('transactionHash', () => res())
        .once('error', e => {
          // Consider 'already known' errors as a successful send
          if (isSameTransactionError(e)){
            res()
          } else {
            rej(e)
          }
        })
    )
  }
  async sendTx({ txDesc, options, extraData }: SendTx<ExtraInfo>): Promise<[PreparedTx, SendAttempt<ExtraInfo>]> {
    const preparedTx = await this.prepareTx({ txDesc, options, extraData })
    return this.sendPreparedTx(preparedTx)
  }

  sendPreparedTx(preparedTx: [PreparedTx, SendAttempt<ExtraInfo>]): Promise<[PreparedTx, SendAttempt<ExtraInfo>]> {
    return new Promise((res, rej) =>
      // prettier-ignore
      this.web3.eth.sendSignedTransaction(preparedTx[0].rawTransaction)
        .once('transactionHash', () => res(preparedTx))
        .once('error', e => {
          // Consider 'already known' errors as a successful send
          if (isSameTransactionError(e)){
            res(preparedTx)
          } else {
            rej(e)
          }
        })
    )
  }
}
