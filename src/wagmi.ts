import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { robinhood } from './chain'
import { rpcUrl } from './config'

export const wagmiConfig = createConfig({
  chains: [robinhood],
  connectors: [injected()],
  transports: {
    [robinhood.id]: http(rpcUrl),
  },
  ssr: false,
  multiInjectedProviderDiscovery: true,
})
