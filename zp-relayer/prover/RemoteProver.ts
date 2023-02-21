import type { Proof } from 'libzkbob-rs-node'
import { Circuit, IProver, PubInput, SecInput } from './IProver'

export class RemoteProver<C extends Circuit> implements IProver<C> {
  constructor(private readonly url: string) {}

  async prove(pub: PubInput<C>, sec: SecInput<C>): Promise<Proof> {
    // TODO: implement
    throw new Error('Not implemented')
  }
}
