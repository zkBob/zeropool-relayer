import type Web3 from 'web3'
import type BN from 'bn.js'
import type { Contract } from 'web3-eth-contract'
import { OP_GAS_ORACLE_ADDRESS } from '@/utils/constants'
import { AbiItem, toBN } from 'web3-utils'
import OracleAbi from '@/abi/op-oracle.json'
import { contractCallRetry } from '@/utils/helpers'
import { BASE_CALLDATA_SIZE } from '@/utils/constants'
import { FeeManager, DefaultFeeEstimate, IFeeEstimateParams, IFeeManagerConfig, IUserFeeOptions } from './FeeManager'
import { IPriceFeed } from '../price-feed'

const MOCK_CALLDATA = '0x' + 'ff'.repeat(BASE_CALLDATA_SIZE)
const ONE_BYTE_GAS = 16

class OptimismUserFeeOptions implements IUserFeeOptions {
  constructor(private fee: BN, private oneByteFee: BN) {}

  applyFactor(factor: BN) {
    this.fee = this.fee.mul(factor).divn(100)
    this.oneByteFee = this.oneByteFee.mul(factor).divn(100)
    return this
  }

  denominate(denominator: BN): this {
    this.fee = this.fee.div(denominator)
    this.oneByteFee = this.oneByteFee.div(denominator)
    return this
  }

  async convert(priceFeed: IPriceFeed) {
    const [fee, oneByteFee] = await priceFeed.convert([this.fee, this.oneByteFee])
    this.fee = fee
    this.oneByteFee = oneByteFee
    return this
  }

  getObject() {
    return {
      fee: this.fee.toString(10),
      oneByteFee: this.oneByteFee.toString(10),
    }
  }
}

export class OptimismFeeManager extends FeeManager {
  private oracle: Contract

  constructor(config: IFeeManagerConfig, web3: Web3) {
    super(config)
    this.oracle = new web3.eth.Contract(OracleAbi as AbiItem[], OP_GAS_ORACLE_ADDRESS)
  }

  async _estimateFee({ gasLimit, data = MOCK_CALLDATA }: IFeeEstimateParams) {
    const l2Fee = await this.estimateExecutionFee(gasLimit)
    const l1Fee = await contractCallRetry(this.oracle, 'getL1Fee', [data]).then(toBN)

    const fee = l2Fee.add(l1Fee)

    return new DefaultFeeEstimate(fee)
  }

  async _getFees({ gasLimit }: IFeeEstimateParams): Promise<OptimismUserFeeOptions> {
    const l2fee = await this.estimateExecutionFee(gasLimit)

    // TODO: cache
    const l1BaseFee = await contractCallRetry(this.oracle, 'l1BaseFee').then(toBN)
    const oneByteFee = l1BaseFee.muln(ONE_BYTE_GAS)

    // TODO: we can compute it without RPC request using `l1BaseFee`
    const l1Fee = await contractCallRetry(this.oracle, 'getL1Fee', [MOCK_CALLDATA]).then(toBN)

    const fee = l1Fee.add(l2fee)

    return new OptimismUserFeeOptions(fee, oneByteFee)
  }
}
