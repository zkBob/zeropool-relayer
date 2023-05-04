import Web3 from 'web3'
import type { TransactionConfig } from 'web3-core'
import { isSameTransactionError } from '@/utils/web3Errors'
import {
  addExtraGasPrice,
  chooseGasPriceOptions,
  EstimationType,
  GasPrice,
  GasPriceValue,
  getGasPriceValue,
} from '@/services/gas-price'
import { getChainId } from '@/utils/web3'
import config from '@/configs/relayerConfig'
import { Mutex } from 'async-mutex'
import { logger } from '@/services/appLogger'
import { readNonce, updateNonce } from '@/utils/redisFields'

export class TxManager {
  nonce!: number
  chainId!: number
  mutex: Mutex

  constructor(private web3: Web3, private privateKey: string, private gasPrice: GasPrice<EstimationType>) {
    this.mutex = new Mutex()
  }

  async init() {
    this.nonce = await readNonce(true)
    await updateNonce(this.nonce)
    this.chainId = await getChainId(this.web3)
  }

  async updateAndBumpGasPrice(
    txConfig: TransactionConfig,
    newGasPrice: GasPriceValue
  ): Promise<[GasPriceValue | null, GasPriceValue]> {
    const oldGasPrice = getGasPriceValue(txConfig)
    if (oldGasPrice) {
      const oldGasPriceWithExtra = addExtraGasPrice(oldGasPrice, config.minGasPriceBumpFactor, null)
      return [oldGasPrice, chooseGasPriceOptions(oldGasPriceWithExtra, newGasPrice)]
    } else {
      return [null, newGasPrice]
    }
  }

  async prepareTx(txConfig: TransactionConfig, tLogger = logger, isResend = false) {
    const release = await this.mutex.acquire()
    try {
      const gasPriceValue = await this.gasPrice.fetchOnce()
      const newGasPriceWithExtra = addExtraGasPrice(gasPriceValue, config.gasPriceSurplus)

      let updatedTxConfig: TransactionConfig = {}
      let newGasPrice: GasPriceValue

      if (isResend) {
        if (typeof txConfig.nonce === 'undefined') {
          throw new Error('Nonce should be set for re-send')
        }
        const [oldGasPrice, updatedGasPrice] = await this.updateAndBumpGasPrice(txConfig, newGasPriceWithExtra)
        newGasPrice = updatedGasPrice
        tLogger.info('Updating tx gasPrice: %o -> %o', oldGasPrice, newGasPrice)
      } else {
        tLogger.info('Nonce', { nonce: this.nonce })
        newGasPrice = newGasPriceWithExtra
        updatedTxConfig.nonce = this.nonce++
        updatedTxConfig.chainId = this.chainId
        await updateNonce(this.nonce)
      }

      updatedTxConfig = {
        ...updatedTxConfig,
        ...txConfig,
        ...newGasPrice,
      }

      const { transactionHash, rawTransaction } = await this.web3.eth.accounts.signTransaction(
        updatedTxConfig,
        this.privateKey
      )
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

  async sendTransaction(rawTransaction: string): Promise<void> {
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
}
