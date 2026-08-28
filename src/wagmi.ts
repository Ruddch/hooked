import { createConfig, fallback, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { robinhood } from './chain'
import { rpcUrls } from './config'

export const wagmiConfig = createConfig({
  chains: [robinhood],
  connectors: [injected()],
  transports: {
    [robinhood.id]: fallback(
      rpcUrls.map((url) =>
        http(url, {
          retryCount: 0,
          timeout: 12_000,
          batch: { wait: 20, batchSize: 8 },
        }),
      ),
      { retryCount: 1 },
    ),
  },
  ssr: false,
  multiInjectedProviderDiscovery: true,
})
