import type Web3 from 'web3'
import type BN from 'bn.js'
import type { Contract } from 'web3-eth-contract'
import type { EstimationType, GasPrice } from '../gas-price'
import { OP_GAS_ORACLE_ADDRESS } from '@/utils/constants'
import { AbiItem, toBN } from 'web3-utils'
import OracleAbi from '@/abi/op-oracle.json'
import { contractCallRetry } from '@/utils/helpers'
import { BASE_CALLDATA_SIZE } from '@/utils/constants'
import { FeeManager, IFeeEstimateParams, IFeeOptions } from './FeeManager'
import type { IPriceFeed } from '../price-feed/IPriceFeed'

const MOCK_CALLDATA = '0x' + 'ff'.repeat(BASE_CALLDATA_SIZE)
const ONE_BYTE_GAS = 16

interface IOptimismFeeOptions extends IFeeOptions {
  oneByteFee: string
}

export class OptimismFeeManager extends FeeManager {
  private oracle: Contract

  constructor(web3: Web3, gasPrice: GasPrice<EstimationType>, priceFeed: IPriceFeed, scaleFactor: BN) {
    super(gasPrice, priceFeed, scaleFactor)
    this.oracle = new web3.eth.Contract(OracleAbi as AbiItem[], OP_GAS_ORACLE_ADDRESS)
  }

  async estimateFee({ gasLimit, data = MOCK_CALLDATA }: IFeeEstimateParams): Promise<BN> {
    const l2Fee = await this.estimateExecutionFee(gasLimit)
    const l1Fee = await contractCallRetry(this.oracle, 'getL1Fee', [data])

    const [fee] = await this.priceFeed.convert([l2Fee.add(toBN(l1Fee))])

    return this.applyScaleFactor(fee)
  }

  async getFees({ gasLimit }: IFeeEstimateParams): Promise<IOptimismFeeOptions> {
    const l2fee = await this.estimateExecutionFee(gasLimit)

    // TODO: cache
    const l1BaseFee = await contractCallRetry(this.oracle, 'l1BaseFee').then(toBN)
    const baseOneByteFee = l1BaseFee.muln(ONE_BYTE_GAS)

    const basel1Fee = await contractCallRetry(this.oracle, 'getL1Fee', [MOCK_CALLDATA]).then(toBN)

    const [fee, oneByteFee] = await this.priceFeed.convert([basel1Fee.add(l2fee), baseOneByteFee])

    return {
      fee: fee.toString(10),
      oneByteFee: oneByteFee.toString(10),
    }
  }
}
