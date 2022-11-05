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

type FlowItem<T extends TxType> = T extends TxType.PERMITTABLE_DEPOSIT
  ? PermitDepositFlowItem
  : T extends TxType.TRANSFER
  ? TransferFlowItem
  : T extends TxType.WITHDRAWAL
  ? WithdrawFlowItem
  : never

export type Flow = {
  independent?: boolean
  accounts: Record<string, string>
  flow: FlowItem<TxType>[]
}

export interface BaseOutputItem<T extends TxType> {
  txType: T
  proof: Proof
  transactionData: TransactionData
  txTypeData: FlowItem<T>
  depositSignature: string | null
}
export interface PermitDepositOutputItem extends BaseOutputItem<TxType.PERMITTABLE_DEPOSIT> {
  deadline: string
  depositSignature: string
}

export interface TransferOutputItem extends BaseOutputItem<TxType.TRANSFER> {}

export interface WithdrawOutputItem extends BaseOutputItem<TxType.WITHDRAWAL> {}

export type FlowOutputItem<T extends TxType> = T extends TxType.PERMITTABLE_DEPOSIT
  ? PermitDepositOutputItem
  : T extends TxType.TRANSFER
  ? TransferOutputItem
  : T extends TxType.WITHDRAWAL
  ? WithdrawOutputItem
  : never

export type FlowOutput = FlowOutputItem<TxType>[]
