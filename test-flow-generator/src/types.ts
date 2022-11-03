import type { Proof, TransactionData } from 'libzkbob-rs-wasm-web'
import type { TxType } from 'zp-memo-parser'

interface PermitDepositFlowItem {
  from: string
  amount: string
}

interface TransferFlowItem {
  zkAddress: string
  amount: string
}

interface WithdrawFlowItem {
  to: string
  amount: string
}

type FlowItem = PermitDepositFlowItem | TransferFlowItem | WithdrawFlowItem

export type Flow = {
  independent?: boolean
  accounts: Record<string, string>
  flow: FlowItem[]
}

export type FlowOutputItem = {
  txType: TxType
  txTypeData?: FlowItem
  depositSignature: string | null
  transactionData: TransactionData
  proof?: Proof
}
export type FlowOutput = FlowOutputItem[]
