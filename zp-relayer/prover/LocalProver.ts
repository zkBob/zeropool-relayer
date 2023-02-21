import { Proof, Params } from 'libzkbob-rs-node'
import { Circuit, IProver, PubInput, SecInput } from './IProver'

type InternalProve<C extends Circuit> = (p: Params, pub: PubInput<C>, sec: SecInput<C>) => Promise<Proof>

export class LocalProver<C extends Circuit> implements IProver<C> {
  private _prove: InternalProve<C>

  constructor(circuit: C, private readonly params: Params) {
    if (circuit === Circuit.Tree) {
      this._prove = Proof.treeAsync as InternalProve<C>
    } else if (circuit === Circuit.DirectDeposit) {
      this._prove = Proof.delegatedDepositAsync as InternalProve<C>
    } else {
      throw new Error('Unsupported circuit')
    }
  }

  prove(pub: PubInput<C>, sec: SecInput<C>): Promise<Proof> {
    return this._prove(this.params, pub, sec)
  }
}
