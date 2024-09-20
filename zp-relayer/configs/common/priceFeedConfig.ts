import { PriceFeedType } from '@/lib/price-feed'
import { z } from 'zod'

const zPriceFeed = z.discriminatedUnion('PRICE_FEED_TYPE', [
  z.object({ PRICE_FEED_TYPE: z.literal(PriceFeedType.Native) }),
  z.object({
    PRICE_FEED_TYPE: z.literal(PriceFeedType.OneInch),
    PRICE_FEED_CONTRACT_ADDRESS: z.string(),
    PRICE_FEED_BASE_TOKEN_ADDRESS: z.string(),
  }),
])

export type PriceFeedConfig = z.infer<typeof zPriceFeed>

export function getPriceFeedConfig(): PriceFeedConfig {
  return zPriceFeed.parse(process.env)
}
