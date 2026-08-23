import { defineChain } from 'viem'
import { explorerUrl, rpcUrl } from './config'

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [rpcUrl] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: explorerUrl },
  },
})
