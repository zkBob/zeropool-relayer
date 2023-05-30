import type Web3 from 'web3'
import type BN from 'bn.js'
import type { Contract } from 'web3-eth-contract'
import type { IPriceFeed } from './IPriceFeed'
import { toBN, toWei, AbiItem } from 'web3-utils'
import { ZERO_ADDRESS } from '@/utils/constants'
import Erc20Abi from '@/abi/erc20.json'
import OracleAbi from '@/abi/one-inch-oracle.json'

// 1Inch price feed oracle: https://github.com/1inch/spot-price-aggregator
export class OneInchPriceFeed implements IPriceFeed {
  private contract: Contract
  private baseTokenAddress: string
  private poolTokenAddress: string

  tokenDecimals!: BN
  private baseTokenDecimals!: BN

  constructor(
    private web3: Web3,
    contractAddress: string,
    config: {
      poolTokenAddress: string
      customBaseTokenAddress: string | null
    }
  ) {
    this.poolTokenAddress = config.poolTokenAddress
    this.baseTokenAddress = config.customBaseTokenAddress || ZERO_ADDRESS
    this.contract = new web3.eth.Contract(OracleAbi as AbiItem[], contractAddress)
  }

  private async getContractDecimals(contractAddress: string): Promise<BN> {
    const contract = new this.web3.eth.Contract(Erc20Abi as AbiItem[], contractAddress)
    const decimals = await contract.methods.decimals().call()
    return toBN(10).pow(toBN(decimals))
  }

  async getBaseTokenDecimals(): Promise<BN> {
    if (!this.baseTokenDecimals) {
      this.baseTokenDecimals =
        this.baseTokenAddress !== ZERO_ADDRESS
          ? await this.getContractDecimals(this.baseTokenAddress)
          : toBN(toWei('1')) // 1 ether
    }
    return this.baseTokenDecimals
  }

  async convert(baseTokenAmounts: BN[]): Promise<BN[]> {
    const baseDecimals = await this.getBaseTokenDecimals()
    const rate = await this.contract.methods
      .getRate(this.baseTokenAddress, this.poolTokenAddress, true)
      .call()
      .then(toBN)

    return baseTokenAmounts.map(a => a.mul(rate).div(baseDecimals))
  }
}
