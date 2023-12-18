import { sleep } from '@/utils/helpers'
import { Network, SendTx, TransactionManager } from '../types'
import { logger } from '@/services/appLogger'

export class TronTxManager implements TransactionManager<Network.Tron> {
  constructor(private tronWeb: any, private pk: string) {}

  async init() {}

  async confirmTx(txHash: string) {
    const info = await this.tronWeb.trx.getTransactionInfo(txHash)
    if (typeof info.blockNumber !== 'number') {
      return null
    }
    return info
  }

  txQueue: SendTx<Network.Tron>[] = []
  private isSending = false

  // TODO: is a race condition possible here?
  async runConsumer() {
    this.isSending = true
    while (this.txQueue.length !== 0) {
      const tx = this.txQueue.shift()
      if (!tx) {
        return // TODO
      }
      const { txDesc, onSend, onIncluded, onRevert } = tx
      const options = {
        feeLimit: txDesc.feeLimit,
        callValue: txDesc.value,
        rawParameter: txDesc.data.slice(10), // TODO: cut off selector
      }
      const txObject = await this.tronWeb.transactionBuilder.triggerSmartContract(txDesc.to, txDesc.func, options, [])
      const signedTx = await this.tronWeb.trx.sign(txObject.transaction, this.pk)

      let info
      const res = await this.tronWeb.trx.sendRawTransaction(signedTx)
      const txHash = res.transaction.txID
      await onSend(txHash)

      while (1) {
        await sleep(1000)
        info = await this.confirmTx(txHash)
        if (info === null) {
          logger.info('Tx not included, waiting...')
          continue
        } else {
          break
        }
      }

      if (info.receipt.result === 'SUCCESS') {
        await onIncluded(info.id)
      } else {
        await onRevert(info.id)
      }
    }
    this.isSending = false
  }

  async safeRunConsumer() {
    try {
      await this.runConsumer()
    } catch (e) {
      logger.error(e)
    }
  }

  async sendTx(a: SendTx<Network.Tron>) {
    this.txQueue.push(a)
    if (!this.isSending) {
      this.safeRunConsumer()
    }
  }
}
