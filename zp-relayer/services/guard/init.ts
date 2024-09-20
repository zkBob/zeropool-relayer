import config from '@/configs/guardConfig'
import { Network, NetworkContract } from '@/lib/network'
import { EthereumContract } from '@/lib/network/evm/EvmContract'
import { TronContract } from '@/lib/network/tron/TronContract'
// @ts-ignore
import TronWeb from 'tronweb'
import Web3 from 'web3'
import PoolAbi from '../../abi/pool-abi.json'

function getPoolContract(): NetworkContract<Network> {
  if (config.GUARD_NETWORK === Network.Tron) {
    const tronWeb = new TronWeb(config.COMMON_RPC_URL[0], config.COMMON_RPC_URL[0], config.COMMON_RPC_URL[0])

    const address = tronWeb.address.fromPrivateKey(config.GUARD_ADDRESS_PRIVATE_KEY.slice(2))
    tronWeb.setAddress(address)

    return new TronContract(tronWeb, PoolAbi, config.COMMON_POOL_ADDRESS)
  } else if (config.GUARD_NETWORK === Network.Ethereum) {
    const web3 = new Web3(config.COMMON_RPC_URL[0])
    return new EthereumContract(web3, PoolAbi, config.COMMON_POOL_ADDRESS)
  } else {
    throw new Error('Unsupported network')
  }
}

export async function init() {
  const poolContract = getPoolContract()

  return { poolContract }
}
