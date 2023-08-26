import type Web3 from 'web3'
import type { Contract, PastEventOptions } from 'web3-eth-contract'
import { logger } from '@/services/appLogger'
import { NetworkBackend } from '@/services/network/NetworkBackend'
import { Network } from '@/services/network/types'

export async function getNonce(web3: Web3, address: string) {
  try {
    logger.debug('Getting transaction count', { address })
    const transactionCount = await web3.eth.getTransactionCount(address)
    logger.debug('Transaction count obtained', { address, transactionCount })
    return transactionCount
  } catch (e) {
    if (e instanceof Error) logger.error(e.message)
    throw new Error('Nonce cannot be obtained')
  }
}

export async function getEvents(contract: Contract, event: string, options: PastEventOptions) {
  try {
    const contractAddress = contract.options.address
    logger.info('Getting past events', {
      contractAddress,
      event,
      fromBlock: options.fromBlock,
      toBlock: options.toBlock,
    })
    const pastEvents = await contract.getPastEvents(event, options)
    logger.debug('Past events obtained', {
      contractAddress,
      event,
      count: pastEvents.length,
    })
    return pastEvents
  } catch (e) {
    if (e instanceof Error) logger.error(e.message)
    throw new Error(`${event} events cannot be obtained`)
  }
}

export async function getTransaction(web3: Web3, txHash: string) {
  try {
    logger.info('Getting tx', { txHash })
    const tx = await web3.eth.getTransaction(txHash)
    logger.debug('Got tx', { txHash })
    return tx
  } catch (e) {
    if (e instanceof Error) logger.error(e.message)
    throw new Error(`${txHash} tx cannot be obtained`)
  }
}

export async function getChainId(web3: Web3) {
  try {
    logger.debug('Getting chain id')
    const chainId = await web3.eth.getChainId()
    logger.debug('Chain id obtained', { chainId })
    return chainId
  } catch (e) {
    if (e instanceof Error) logger.error(e.message)
    throw new Error('Chain Id cannot be obtained')
  }
}

export async function getBlockNumber(network: NetworkBackend<Network>) {
  try {
    logger.debug('Getting block number')
    const blockNumber = await network.getBlockNumber()
    logger.debug('Block number obtained', { blockNumber })
    return blockNumber
  } catch (e) {
    if (e instanceof Error) logger.error(e.message)
    throw new Error(`Block Number cannot be obtained`)
  }
}
