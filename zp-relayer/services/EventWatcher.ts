// Reference implementation:
// https://github.com/omni/tokenbridge/blob/master/oracle/src/watcher.js
import { logger } from '@/services/appLogger'
import { getBlockNumber, getEvents } from '@/utils/web3'
import type { Redis } from 'ioredis'
import type Web3 from 'web3'
import type { Contract, EventData } from 'web3-eth-contract'

interface IWatcherConfig {
  name: string
  startBlock: number
  blockConfirmations: number
  eventName: string
  eventPollingInterval: number
  eventsProcessingBatchSize: number
  redis: Redis
  web3: Web3
  contract: Contract
  callback: (events: EventData[]) => Promise<void>
}

export class EventWatcher {
  lastProcessedBlock: number
  lastBlockRedisKey: string

  constructor(private config: IWatcherConfig) {
    this.lastBlockRedisKey = `${config.name}:lastProcessedBlock`
    this.lastProcessedBlock = Math.max(config.startBlock - 1, 0)
  }

  async init() {
    await this.getLastProcessedBlock()
  }

  private async getLastProcessedBlock() {
    const result = await this.config.redis.get(this.lastBlockRedisKey)
    logger.debug('Last Processed block obtained', { fromRedis: result, fromConfig: this.lastProcessedBlock })
    this.lastProcessedBlock = result ? parseInt(result, 10) : this.lastProcessedBlock
  }

  private updateLastProcessedBlock(lastBlockNumber: number) {
    this.lastProcessedBlock = lastBlockNumber
    return this.config.redis.set(this.lastBlockRedisKey, this.lastProcessedBlock)
  }

  private async getLastBlockToProcess(web3: Web3) {
    const lastBlockNumber = await getBlockNumber(web3)
    return lastBlockNumber - this.config.blockConfirmations
  }

  private async watch() {
    const lastBlockToProcess = await this.getLastBlockToProcess(this.config.web3)

    if (lastBlockToProcess <= this.lastProcessedBlock) {
      logger.debug('All blocks already processed')
      return
    }

    const fromBlock = this.lastProcessedBlock + 1
    const rangeEndBlock = fromBlock + this.config.eventsProcessingBatchSize
    let toBlock = Math.min(lastBlockToProcess, rangeEndBlock)

    let events = await getEvents(this.config.contract, this.config.eventName, {
      fromBlock,
      toBlock,
    })
    logger.info(`Found ${events.length} events`)

    await this.config.callback(events)

    logger.debug('Updating last processed block', { lastProcessedBlock: toBlock.toString() })
    await this.updateLastProcessedBlock(toBlock)
  }

  async run() {
    try {
      await this.watch()
    } catch (e) {
      logger.error(e)
    }

    setTimeout(() => {
      this.run()
    }, this.config.eventPollingInterval)
  }
}
