import { expect } from 'chai'
import { toBN } from 'web3-utils'
import { EIP1559GasPriceWithinLimit } from '../../services/gas-price/GasPrice'

describe('GasPrice', () => {
  it('correctly calculates fee limit', () => {
    const fees = {
      maxFeePerGas: '15',
      maxPriorityFeePerGas: '7',
    }

    expect(EIP1559GasPriceWithinLimit(fees, toBN(100))).to.eql({
      maxFeePerGas: '15',
      maxPriorityFeePerGas: '7',
    })

    expect(EIP1559GasPriceWithinLimit(fees, toBN(10))).to.eql({
      maxFeePerGas: '10',
      maxPriorityFeePerGas: '7',
    })

    expect(EIP1559GasPriceWithinLimit(fees, toBN(6))).to.eql({
      maxFeePerGas: '6',
      maxPriorityFeePerGas: '6',
    })
  })
})
