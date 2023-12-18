// @ts-ignore
import TronWeb from 'tronweb'
import config from '@/configs/guardConfig'
import { Network, NetworkContract } from '@/services/network'
import { EthereumContract } from '@/services/network/evm/EvmContract'
import { TronContract } from '@/services/network/tron/TronContract'
import Web3 from 'web3'
import PoolAbi from '../abi/pool-abi.json'

import { Wallet } from 'ethers'

function getPoolContract(): NetworkContract<Network> {
  if (config.GUARD_NETWORK === Network.Tron) {
    const tronWeb = new TronWeb(config.COMMON_RPC_URL[0])
    return new TronContract(tronWeb, PoolAbi, config.COMMON_POOL_ADDRESS)
  } else if (config.GUARD_NETWORK === Network.Ethereum) {
    const web3 = new Web3(config.COMMON_RPC_URL[0])
    return new EthereumContract(web3, PoolAbi, config.COMMON_POOL_ADDRESS)
  } else {
    throw new Error('Unsupported network')
  }
}

export async function init() {
  const signer = new Wallet(config.GUARD_ADDRESS_PRIVATE_KEY)

  const poolContract = getPoolContract()

  return { signer, poolContract }
}
