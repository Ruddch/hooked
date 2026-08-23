import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { ConnectModal, WalletUiProvider } from './components/ConnectWallet'
import { HomePage } from './pages/Home'
import { wagmiConfig } from './wagmi'
import './styles/site.css'
import './styles/wallet.css'

const queryClient = new QueryClient()

export default function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WalletUiProvider>
          <HomePage />
          <ConnectModal />
        </WalletUiProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
