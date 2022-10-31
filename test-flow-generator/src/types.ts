import type { TransactionData } from 'libzkbob-rs-wasm-web'

interface PermitDepositFlowItem {
  from: string,
  amount: string,
}

interface TransferFlowItem {
  zkAddress: string,
  amount: string,
}

interface WithdrawFlowItem {
  to: string,
  amount: string,
}

type FlowItem = PermitDepositFlowItem | TransferFlowItem | WithdrawFlowItem

export type Flow = {
  accounts: Record<string, string>,
  flow: FlowItem[],
}

type FlowOutputItem = {
  txTypeData?: FlowItem,
  depositSignature: string | null
  transactionData: TransactionData
}
export type FlowOutput = FlowOutputItem[]