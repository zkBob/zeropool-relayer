import type Web3 from 'web3'
import type BN from 'bn.js'
import type { Contract } from 'web3-eth-contract'
import { OP_GAS_ORACLE_ADDRESS, MOCK_CALLDATA } from '@/utils/constants'
import { AbiItem, toBN, hexToBytes } from 'web3-utils'
import OracleAbi from '@/abi/op-oracle.json'
import { contractCallRetry } from '@/utils/helpers'
import {
  FeeManager,
  FeeEstimate,
  IFeeEstimateParams,
  IFeeManagerConfig,
  IUserFeeOptions,
  IGetFeesParams,
} from './FeeManager'
import type { IPriceFeed } from '../price-feed'
import type { EstimationType, GasPrice } from '../gas-price'

const ZERO_BYTE_GAS = 4
const NZERO_BYTE_GAS = 16

class OptimismUserFeeOptions implements IUserFeeOptions {
  constructor(private baseFee: BN, private oneByteFee: BN) {}

  applyFactor(factor: BN) {
    this.baseFee = this.baseFee.mul(factor).divn(100)
    this.oneByteFee = this.oneByteFee.mul(factor).divn(100)
    return this
  }

  denominate(denominator: BN): this {
    this.baseFee = this.baseFee.div(denominator)
    this.oneByteFee = this.oneByteFee.div(denominator)
    return this
  }

  async convert(priceFeed: IPriceFeed) {
    const [l2fee, oneByteFee] = await priceFeed.convert([this.baseFee, this.oneByteFee])
    this.baseFee = l2fee
    this.oneByteFee = oneByteFee
    return this
  }

  getObject() {
    return {
      baseFee: this.baseFee.toString(10),
      oneByteFee: this.oneByteFee.toString(10),
    }
  }
}

export class OptimismFeeManager extends FeeManager {
  private oracle: Contract
  private overhead!: BN
  private decimals!: BN
  private scalar!: BN

  constructor(config: IFeeManagerConfig, private gasPrice: GasPrice<EstimationType>, web3: Web3) {
    super(config)
    this.oracle = new web3.eth.Contract(OracleAbi as AbiItem[], OP_GAS_ORACLE_ADDRESS)
  }

  async init() {
    this.overhead = await contractCallRetry(this.oracle, 'overhead').then(toBN)
    this.decimals = await contractCallRetry(this.oracle, 'decimals').then(toBN)
    this.scalar = await contractCallRetry(this.oracle, 'scalar').then(toBN)
  }

  private getL1GasUsed(data: string): BN {
    const byteToGas = (byte: number) => (byte === 0 ? ZERO_BYTE_GAS : NZERO_BYTE_GAS)
    const bytes = hexToBytes(data)
    const l1GasUsed = bytes.reduce((acc, byte) => acc + byteToGas(byte), 0)
    return toBN(l1GasUsed).add(this.overhead)
  }

  // Mimics OP gas price oracle algorithm
  private getL1Fee(data: string, l1BaseFee: BN): BN {
    const l1GasUsed = this.getL1GasUsed(data)
    const l1Fee = l1GasUsed.mul(l1BaseFee)
    const divisor = toBN(10).pow(this.decimals)
    const unscaled = l1Fee.mul(this.scalar)
    const scaled = unscaled.div(divisor)
    return scaled
  }

  async _estimateFee({ extraData }: IFeeEstimateParams, feeOptions: OptimismUserFeeOptions) {
    const { baseFee, oneByteFee } = feeOptions.getObject()

    const unscaledL1Fee = this.getL1Fee(MOCK_CALLDATA + extraData, toBN(oneByteFee))

    // Because oneByteFee = l1BaseFee * NZERO_BYTE_GAS, we need to divide the estimation
    // We do it here to get a more accurate result
    const l1Fee = unscaledL1Fee.divn(NZERO_BYTE_GAS)

    const fee = toBN(baseFee).add(l1Fee)

    return new FeeEstimate(fee)
  }

  async _getFees({ gasLimit }: IGetFeesParams): Promise<OptimismUserFeeOptions> {
    const baseFee = await FeeManager.estimateExecutionFee(this.gasPrice, gasLimit)

    // TODO: cache
    const l1BaseFee = await contractCallRetry(this.oracle, 'l1BaseFee').then(toBN)
    // Use an upper bound for the oneByteFee
    const oneByteFee = l1BaseFee.muln(NZERO_BYTE_GAS)

    return new OptimismUserFeeOptions(baseFee, oneByteFee)
  }
}
