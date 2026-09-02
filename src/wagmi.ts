import {
  ChainDisconnectedError,
  ProviderDisconnectedError,
  createTransport,
  hexToNumber,
  withTimeout,
  type EIP1193Provider,
  type EIP1193RequestFn,
} from 'viem'
import { createConfig, fallback, http, type Config, type Transport } from 'wagmi'
import { getAccount } from 'wagmi/actions'
import { injected } from 'wagmi/connectors'
import { robinhood } from './chain'
import { rpcUrls } from './config'

const RPC_TIMEOUT_MS = 12_000

const configRef: { current: Config | null } = { current: null }

/** Use the connected injected wallet's EIP-1193 provider as RPC; throw if unused. */
function connectedWallet(): Transport {
  return ({ chain }) => {
    const request: EIP1193RequestFn = async ({ method, params }) => {
      const config = configRef.current
      if (!config) {
        throw new ProviderDisconnectedError(new Error('Wagmi config not ready.'))
      }

      const { connector, status } = getAccount(config)
      if (status !== 'connected' || !connector) {
        throw new ProviderDisconnectedError(new Error('Wallet not connected.'))
      }

      const provider = (await connector.getProvider({
        chainId: chain?.id,
      })) as EIP1193Provider | undefined
      if (!provider?.request) {
        throw new ProviderDisconnectedError(new Error('No wallet provider.'))
      }

      if (chain) {
        const walletChainId = hexToNumber(
          await withTimeout(() => provider.request({ method: 'eth_chainId' }), {
            timeout: 1_000,
          }),
        )
        if (walletChainId !== chain.id) {
          throw new ChainDisconnectedError(
            new Error(`Wallet chain ${walletChainId} does not match ${chain.id}.`),
          )
        }
      }

      return withTimeout(
        () => provider.request({ method, params } as never),
        { timeout: RPC_TIMEOUT_MS },
      )
    }

    return createTransport({
      key: 'connected-wallet',
      name: 'Connected Wallet',
      type: 'connected-wallet',
      retryCount: 0,
      request,
    })
  }
}

const httpTransports = rpcUrls.map((url) =>
  http(url, {
    retryCount: 0,
    timeout: RPC_TIMEOUT_MS,
    batch: { wait: 20, batchSize: 8 },
  }),
)

export const wagmiConfig = createConfig({
  chains: [robinhood],
  connectors: [injected()],
  transports: {
    [robinhood.id]: fallback([connectedWallet(), ...httpTransports], {
      retryCount: 1,
    }),
  },
  ssr: false,
  multiInjectedProviderDiscovery: true,
})

configRef.current = wagmiConfig
