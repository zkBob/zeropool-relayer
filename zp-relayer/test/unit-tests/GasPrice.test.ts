import { expect } from 'chai'
import { toBN } from 'web3-utils'
import { EIP1559GasPriceWithinLimit, addExtraGasPrice } from '../../services/gas-price/GasPrice'

describe('GasPrice', () => {
  it('correctly calculates fee limit', () => {
    const fees = {
      maxFeePerGas: '15',
      maxPriorityFeePerGas: '7',
    }

    expect(EIP1559GasPriceWithinLimit(fees, toBN(100))).eql({
      maxFeePerGas: '15',
      maxPriorityFeePerGas: '7',
    })

    expect(EIP1559GasPriceWithinLimit(fees, toBN(10))).eql({
      maxFeePerGas: '10',
      maxPriorityFeePerGas: '7',
    })

    expect(EIP1559GasPriceWithinLimit(fees, toBN(6))).eql({
      maxFeePerGas: '6',
      maxPriorityFeePerGas: '6',
    })
  })
  it('applies gas fee bump', () => {
    let fees = {
      maxFeePerGas: '100',
      maxPriorityFeePerGas: '50',
    }

    expect(addExtraGasPrice(fees)).eql({
      maxFeePerGas: '110',
      maxPriorityFeePerGas: '55',
    })

    expect(addExtraGasPrice(fees, 0.1, toBN(100))).eql({
      maxFeePerGas: '100',
      maxPriorityFeePerGas: '55',
    })

    expect(addExtraGasPrice(fees, 0.1, toBN(52))).eql({
      maxFeePerGas: '52',
      maxPriorityFeePerGas: '52',
    })

    fees = {
      maxFeePerGas: '174',
      maxPriorityFeePerGas: '56',
    }
    // Should be rounded correctly
    expect(addExtraGasPrice(fees)).eql({
      maxFeePerGas: '191',
      maxPriorityFeePerGas: '62',
    })

    // Works with 0 bump
    expect(addExtraGasPrice(fees, 0)).eql(fees)
  })
})
