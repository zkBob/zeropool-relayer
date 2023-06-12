import type { Permit2Recover } from './Permit2Recover'
import type { SaltedPermitRecover } from './SaltedPermitRecover'

export type PermitRecover = Permit2Recover | SaltedPermitRecover

export enum PermitType {
  Permit2 = 'permit2',
  SaltedPermit = 'salted-permit',
}
