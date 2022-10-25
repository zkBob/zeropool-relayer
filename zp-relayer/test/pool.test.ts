import { expect } from 'chai'
import { EIP1559GasPriceWithinLimit } from '../services/gas-price/GasPrice'
import { toBN } from 'web3-utils'

describe('Pool', () => {
  it('correctly calculates fee limit', () => {
    const fees = {
      maxFeePerGas: '15',
      maxPriorityFeePerGas: '7',
    }

    expect(EIP1559GasPriceWithinLimit(fees, toBN(100))).to.deep.equal({
      maxFeePerGas: '15',
      maxPriorityFeePerGas: '7',
    })

    expect(EIP1559GasPriceWithinLimit(fees, toBN(10))).to.deep.equal({
      maxFeePerGas: '10',
      maxPriorityFeePerGas: '7',
    })

    expect(EIP1559GasPriceWithinLimit(fees, toBN(6))).to.deep.equal({
      maxFeePerGas: '6',
      maxPriorityFeePerGas: '6',
    })
  })
})
