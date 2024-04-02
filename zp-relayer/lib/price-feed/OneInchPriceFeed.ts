import Erc20Abi from '@/abi/erc20.json'
import OracleAbi from '@/abi/one-inch-oracle.json'
import { ZERO_ADDRESS } from '@/utils/constants'
import type BN from 'bn.js'
import { toBN, toWei } from 'web3-utils'
import { NetworkBackend } from '../network/NetworkBackend'
import { Network, NetworkContract } from '../network/types'
import type { IPriceFeed } from './IPriceFeed'

// 1Inch price feed oracle: https://github.com/1inch/spot-price-aggregator
export class OneInchPriceFeed implements IPriceFeed {
  private contract: NetworkContract<Network>
  private baseTokenAddress: string
  private baseTokenDecimals!: BN
  private poolTokenAddress: string

  constructor(
    private network: NetworkBackend<Network>,
    contractAddress: string,
    config: {
      poolTokenAddress: string
      customBaseTokenAddress: string | null
    }
  ) {
    this.poolTokenAddress = config.poolTokenAddress
    this.baseTokenAddress = config.customBaseTokenAddress || ZERO_ADDRESS
    this.contract = network.contract(OracleAbi, contractAddress)
  }

  async init() {
    if (this.baseTokenAddress !== ZERO_ADDRESS) {
      this.baseTokenDecimals = await this.getContractDecimals(this.baseTokenAddress)
    } else {
      this.baseTokenDecimals = toBN(toWei('1')) // 1 ether
    }
  }

  private async getContractDecimals(contractAddress: string): Promise<BN> {
    const contract = this.network.contract(Erc20Abi, contractAddress)
    const decimals = await contract.call('decimals')
    return toBN(10).pow(toBN(decimals))
  }

  getRate(): Promise<BN> {
    return this.contract.call('getRate', [this.baseTokenAddress, this.poolTokenAddress, true]).then(toBN)
  }

  convert(rate: BN, baseTokenAmount: BN): BN {
    const baseDecimals = this.baseTokenDecimals

    return baseTokenAmount.mul(rate).div(baseDecimals)
  }
}
