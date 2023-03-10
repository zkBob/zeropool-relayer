import { expect } from 'chai'
import { toBN } from 'web3-utils'
import { checkDeadline } from '../../validation/tx/validateTx'

describe('Validation', () => {
  it('correctly checks deadline', () => {
    // current time + 10 sec
    const signedDeadline = toBN(Math.floor(Date.now() / 1000) + 10)

    expect(checkDeadline(signedDeadline, 7)).to.be.null
    expect(checkDeadline(signedDeadline, 11)).to.be.instanceOf(Error)
  })
})
