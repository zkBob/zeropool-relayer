import type { Permit2Recover } from './Permit2Recover'
import type { SaltedPermitRecover } from './SaltedPermitRecover'
import type { TransferWithAuthorizationRecover } from './TransferWithAuthorizationRecover'

export type PermitRecover = Permit2Recover | SaltedPermitRecover | TransferWithAuthorizationRecover | null

export enum PermitType {
  None = 'none', // only deposits via explicit approve are allowed
  Permit2 = 'permit2',
  SaltedPermit = 'salted-permit',
  TransferWithAuthorization = 'transfer-with-authorization',
}
