import type Web3 from 'web3'
import type BN from 'bn.js'
import type { Contract } from 'web3-eth-contract'
import { OP_GAS_ORACLE_ADDRESS } from '@/utils/constants'
import { AbiItem, toBN, hexToBytes } from 'web3-utils'
import OracleAbi from '@/abi/op-oracle.json'
import { contractCallRetry } from '@/utils/helpers'
import { FeeManager, FeeEstimate, IFeeEstimateParams, IFeeManagerConfig, DynamicFeeOptions } from './FeeManager'
import relayerConfig from '@/configs/relayerConfig'
import { ZERO_BYTE_GAS, NZERO_BYTE_GAS } from '@/utils/constants'
import type { EstimationType, GasPrice } from '../gas-price'

// Rough estimation of tx RLP encoding overhead in bytes
const RLP_ENCODING_OVERHEAD = toBN(120)
const SIGNATURE_GAS = toBN(68 * 16)

export class OptimismFeeManager extends FeeManager {
  public oracle: Contract
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

  private getL1GasUsed(data: string, includeOverhead: boolean): BN {
    const byteToGas = (byte: number) => (byte === 0 ? ZERO_BYTE_GAS : NZERO_BYTE_GAS)
    const bytes = hexToBytes(data)
    const total = bytes.reduce((acc, byte) => acc + byteToGas(byte), 0)
    const unsigned = toBN(total)
    if (includeOverhead) {
      const totalOverhead = this.overhead.add(SIGNATURE_GAS).add(RLP_ENCODING_OVERHEAD)
      unsigned.iadd(totalOverhead)
    }
    return unsigned
  }

  // Mimics OP gas price oracle algorithm
  private getL1Fee(data: string, l1BaseFee: BN, includeOverhead: boolean): BN {
    const l1GasUsed = this.getL1GasUsed(data, includeOverhead)
    const l1Fee = l1GasUsed.mul(l1BaseFee)
    const divisor = toBN(10).pow(this.decimals)
    const unscaled = l1Fee.mul(this.scalar)
    const scaled = unscaled.div(divisor)
    return scaled
  }

  async _estimateFee({ txType, nativeConvert, txData }: IFeeEstimateParams, feeOptions: DynamicFeeOptions) {
    const { [txType]: baseFee, nativeConvertFee, oneByteFee } = feeOptions.fees
    // -1 to account for the 0x prefix
    const calldataLen = (txData.length >> 1) - 1
    const fee = baseFee.add(oneByteFee.muln(calldataLen))
    if (nativeConvert) {
      fee.iadd(nativeConvertFee)
    }
    return new FeeEstimate({ fee })
  }

  async _fetchFeeOptions(): Promise<DynamicFeeOptions> {
    const gasPrice = await this.gasPrice.fetchOnce()

    const l1BaseFee = await contractCallRetry(this.oracle, 'l1BaseFee').then(toBN)

    const oneByteFee = this.getL1Fee('0xff', l1BaseFee, false)
    const baseExtra = this.getL1Fee('0x', l1BaseFee, true)

    return DynamicFeeOptions.fromParams({
      gasPrice,
      oneByteFee,
      minFee: relayerConfig.minBaseFee,
      baseExtra,
    })
  }
}
