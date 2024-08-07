import OracleAbi from '@/abi/op-oracle.json'
import relayerConfig from '@/configs/relayerConfig'
import { NZERO_BYTE_GAS, OP_GAS_ORACLE_ADDRESS, ZERO_BYTE_GAS } from '@/utils/constants'
import type BN from 'bn.js'
import { hexToBytes, toBN } from 'web3-utils'
import type { EstimationType, GasPrice } from '../gas-price'
import { NetworkBackend } from '../network/NetworkBackend'
import { Network, NetworkContract } from '../network/types'
import { DynamicFeeOptions, FeeEstimate, FeeManager, IFeeEstimateParams, IFeeManagerConfig } from './FeeManager'

export class OptimismFeeManager extends FeeManager {
  private oracle: NetworkContract<Network.Ethereum>
  private overhead!: BN
  private decimals!: BN
  private scalar!: BN
  private gasPrice: GasPrice<EstimationType>

  constructor(config: IFeeManagerConfig, network: NetworkBackend<Network.Ethereum>) {
    super(config)
    // @ts-ignore
    this.gasPrice = network.gasPrice
    this.oracle = network.contract(OracleAbi, OP_GAS_ORACLE_ADDRESS)
  }

  async init() {
    this.overhead = await this.oracle.callRetry('overhead').then(toBN)
    this.decimals = await this.oracle.callRetry('decimals').then(toBN)
    this.scalar = await this.oracle.callRetry('scalar').then(toBN)
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

  async _estimateFee({ txType, nativeConvert, txData }: IFeeEstimateParams, feeOptions: DynamicFeeOptions) {
    const { [txType]: baseFee, nativeConvertFee, oneByteFee } = feeOptions.fees

    const unscaledL1Fee = this.getL1Fee(txData, oneByteFee)

    // Because oneByteFee = l1BaseFee * NZERO_BYTE_GAS, we need to divide the estimation
    // We do it here to get a more accurate result
    const l1Fee = unscaledL1Fee.divn(NZERO_BYTE_GAS)

    const fee = baseFee.add(l1Fee)
    if (nativeConvert) {
      fee.iadd(nativeConvertFee)
    }
    return new FeeEstimate({ fee })
  }

  async _fetchFeeOptions(): Promise<DynamicFeeOptions> {
    const gasPrice = await this.gasPrice.fetchOnce()

    const l1BaseFee = await this.oracle.callRetry('l1BaseFee').then(toBN)

    const oneByteFee = l1BaseFee.muln(NZERO_BYTE_GAS)

    return DynamicFeeOptions.fromGasPice(gasPrice, oneByteFee, relayerConfig.RELAYER_MIN_BASE_FEE)
  }
}
