import { logger } from '@/lib/appLogger'
import { Event, Network, NetworkBackend, NetworkContract } from '@/lib/network'
import { redis } from '@/lib/redisClient'
import { getBlockNumber } from '@/utils/web3'

interface WatcherConfig {
  event: string
  blockConfirmations: number
  startBlock: number
  eventPollingInterval: number
  batchSize: number
  processor: (batch: Event[]) => Promise<void>
}

export class Watcher<N extends Network> {
  private lastProcessedBlock: number
  private lastBlockRedisKey: string

  constructor(
    private network: NetworkBackend<N>,
    private contract: NetworkContract<N>,
    serviceKey: string,
    private config: WatcherConfig
  ) {
    this.lastProcessedBlock = Math.max(config.startBlock - 1, 0)
    this.lastBlockRedisKey = `${serviceKey}:lastProcessedBlock`
  }

  async init() {
    const result = await redis.get(this.lastBlockRedisKey)
    logger.debug('Last Processed block obtained', { fromRedis: result, fromConfig: this.lastProcessedBlock })
    this.lastProcessedBlock = result ? parseInt(result, 10) : this.lastProcessedBlock
  }

  private async watch() {
    const lastBlockNumber = await getBlockNumber(this.network)
    const lastBlockToProcess = lastBlockNumber - this.config.blockConfirmations

    const fromBlock = this.lastProcessedBlock + 1

    const rangeEndBlock = fromBlock + this.config.batchSize
    let toBlock = Math.min(lastBlockToProcess, rangeEndBlock)

    try {
      for await (const batch of this.network.getEvents({
        startBlock: fromBlock,
        lastBlock: toBlock,
        event: this.config.event,
        batchSize: this.config.batchSize,
        contract: this.contract,
      })) {
        logger.info(`Found ${batch.events.length} ${this.config.event} events`)
        await this.config.processor(batch.events)
        logger.debug('Updating last processed block', { lastProcessedBlock: toBlock.toString() })

        this.lastProcessedBlock = batch.toBlock
        await redis.set(this.lastBlockRedisKey, this.lastProcessedBlock)
      }
    } catch (e) {
      logger.error('Error processing events, continuing...', e)
    }
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
