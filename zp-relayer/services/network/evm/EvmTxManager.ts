import Web3 from 'web3'
import { isSameTransactionError } from '@/utils/web3Errors'
import {
  addExtraGasPrice,
  chooseGasPriceOptions,
  EstimationType,
  GasPrice,
  GasPriceValue,
  getGasPriceValue,
} from '@/services/gas-price'
import { getChainId, getNonce } from '@/utils/web3'
import config from '@/configs/relayerConfig'
import { Mutex } from 'async-mutex'
import { logger } from '@/services/appLogger'
import { readNonce, updateNonce } from '@/utils/redisFields'
import type { Network, SendTx, TransactionManager, Tx, TxDesc } from '@/services/network/types'
import { Logger } from 'winston'
import { sleep } from '@/utils/helpers'
import type { TransactionReceipt, TransactionConfig } from 'web3-core'

export class EvmTxManager implements TransactionManager<Network.Ethereum> {
  txQueue: SendTx<Network.Ethereum>[] = []
  private isSending = false
  nonce!: number
  chainId!: number
  mutex: Mutex
  logger!: Logger

  constructor(private web3: Web3, private pk: string, private gasPrice: GasPrice<EstimationType>) {
    this.mutex = new Mutex()
  }

  async init() {
    this.nonce = await readNonce(this.web3)(true)
    await updateNonce(this.nonce)
    this.chainId = await getChainId(this.web3)
  }

  async updateAndBumpGasPrice(
    txConfig: TransactionConfig,
    newGasPrice: GasPriceValue
  ): Promise<[GasPriceValue | null, GasPriceValue]> {
    const oldGasPrice = getGasPriceValue(txConfig)
    if (oldGasPrice) {
      const oldGasPriceWithExtra = addExtraGasPrice(oldGasPrice, config.RELAYER_MIN_GAS_PRICE_BUMP_FACTOR, null)
      return [oldGasPrice, chooseGasPriceOptions(oldGasPriceWithExtra, newGasPrice)]
    } else {
      return [null, newGasPrice]
    }
  }

  async prepareTx(
    txDesc: TxDesc<Network.Ethereum>,
    { isResend = false, shouldUpdateGasPrice = true }: { isResend?: boolean; shouldUpdateGasPrice?: boolean }
  ) {
    const release = await this.mutex.acquire()
    try {
      const gasPriceValue = shouldUpdateGasPrice ? await this.gasPrice.fetchOnce() : this.gasPrice.getPrice()
      const newGasPriceWithExtra = addExtraGasPrice(
        gasPriceValue,
        config.RELAYER_GAS_PRICE_SURPLUS,
        config.RELAYER_MAX_FEE_PER_GAS_LIMIT
      )

      let updatedTxConfig: TransactionConfig = {}
      let newGasPrice: GasPriceValue

      if (isResend) {
        if (typeof txDesc.nonce === 'undefined') {
          throw new Error('Nonce should be set for re-send')
        }
        const [oldGasPrice, updatedGasPrice] = await this.updateAndBumpGasPrice(txDesc, newGasPriceWithExtra)
        newGasPrice = updatedGasPrice
        logger.info('Updating tx gasPrice: %o -> %o', oldGasPrice, newGasPrice)
      } else {
        logger.info('Nonce', { nonce: this.nonce })
        newGasPrice = newGasPriceWithExtra
        updatedTxConfig.nonce = this.nonce++
        updatedTxConfig.chainId = this.chainId
        await updateNonce(this.nonce)
      }

      updatedTxConfig = {
        ...updatedTxConfig,
        ...txDesc,
        ...newGasPrice,
      }
      const { transactionHash, rawTransaction } = await this.web3.eth.accounts.signTransaction(updatedTxConfig, this.pk)

      return {
        txHash: transactionHash as string,
        rawTransaction: rawTransaction as string,
        gasPrice: newGasPrice,
        txConfig: updatedTxConfig,
      }
    } finally {
      release()
    }
  }

  async confirmTx(txHashes: string[], txNonce: number): Promise<TransactionReceipt | null> {
    // Transaction was not mined
    const actualNonce = await getNonce(this.web3, config.RELAYER_ADDRESS)
    logger.info('Nonce value from RPC: %d; tx nonce: %d', actualNonce, txNonce)
    if (actualNonce <= txNonce) {
      return null
    }

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
      if (tx && tx.blockNumber) return tx
    }
    return null
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

  async consumer() {
    this.isSending = true
    while (this.txQueue.length !== 0) {
      const a = this.txQueue.shift()
      if (!a) {
        return // TODO
      }
      const { txDesc, onSend, onIncluded, onRevert } = a

      let isResend = false
      const sendAttempts: string[] = []
      while (1) {
        const { txConfig } = await this.prepareTx(txDesc, {
          isResend,
          shouldUpdateGasPrice: false,
        })
        const signedTx = await this.web3.eth.accounts.signTransaction(txConfig, this.pk)
        const txHash = signedTx.transactionHash as string

        sendAttempts.push(txHash)
        logger.info('Sending tx', { txHash })
        await this._sendTx(signedTx.rawTransaction as string)
        await onSend(txHash)

        await sleep(1000)

        const receipt = await this.confirmTx(sendAttempts, txConfig.nonce as number)
        if (receipt === null) {
          continue
        }
        if (receipt.status) {
          await onIncluded(txHash)
        } else {
          await onRevert(txHash)
        }
        break
      }
    }
    this.isSending = false
  }

  async sendTx(sendTx: SendTx<Network.Ethereum>) {
    logger.info('Adding tx to queue', { txDesc: sendTx.txDesc })
    this.txQueue.push(sendTx)
    if (!this.isSending) {
      this.consumer()
    }
  }
}
