import { PreparedTx, SendAttempt, SendError, SendTx, TransactionManager, TxInfo } from '../types'
import BN from 'bn.js'

interface ExtraInfo {}

export class TronTxManager implements TransactionManager<ExtraInfo> {
  constructor(private tronWeb: any, private pk: string) {}

  async init() {}

  async confirmTx(txHashes: string[]): Promise<[TxInfo | null, boolean]> {
    for (let i = txHashes.length - 1; i >= 0; i--) {
      const txHash = txHashes[i]
      const info = await this.tronWeb.trx.getTransactionInfo(txHash)
      if (typeof info.blockNumber !== 'number') {
        return [null, false]
      }
      return [
        {
          blockNumber: info.blockNumber,
          txHash: info.id,
          success: info.receipt.result === 'SUCCESS',
        },
        false,
      ]
    }

    return [null, false]
  }

  async prepareTx({
    txDesc,
    options: { maxFeeLimit, func },
  }: SendTx<ExtraInfo>): Promise<[PreparedTx, SendAttempt<ExtraInfo>]> {
    const options = {
      feeLimit: maxFeeLimit,
      callValue: txDesc.value,
      rawParameter: txDesc.data.slice(10),
    }
    const txObject = await this.tronWeb.transactionBuilder.triggerSmartContract(txDesc.to, func, options, [])
    // XXX: this is not a string, but an object
    const signedTx = await this.tronWeb.trx.sign(txObject.transaction, this.pk)

    return [
      {
        rawTransaction: signedTx,
      },
      {
        txHash: signedTx.txID,
        extraData: {},
      },
    ]
  }

  async sendPreparedTx(
    preparedTx: [PreparedTx, SendAttempt<ExtraInfo>]
  ): Promise<[PreparedTx, SendAttempt<ExtraInfo>]> {
    await this.tronWeb.trx.sendRawTransaction(preparedTx[0].rawTransaction)
    return preparedTx
  }

  async resendTx(
    sendAttempts: SendAttempt<ExtraInfo>[]
  ): Promise<{ attempt?: SendAttempt<ExtraInfo> | undefined; error?: SendError | undefined }> {
    // TODO: check tx timestamp to resend
    throw new Error('Method not implemented.')
  }

  async sendTx(sendTx: SendTx<ExtraInfo>) {
    const preparedTx = await this.prepareTx(sendTx)
    return this.sendPreparedTx(preparedTx)
  }

  waitingForFunds(minimumBalance: BN, cb: (balance: BN) => void): Promise<void> {
    throw new Error('Method not implemented');
  }
}
