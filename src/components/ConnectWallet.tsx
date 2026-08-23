import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useAccount, useConnect, useConnectors, useDisconnect } from 'wagmi'

type WalletUi = {
  open: boolean
  setOpen: (v: boolean) => void
}

const WalletUiContext = createContext<WalletUi | null>(null)

export function WalletUiProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const value = useMemo(() => ({ open, setOpen }), [open])
  return <WalletUiContext.Provider value={value}>{children}</WalletUiContext.Provider>
}

export function useWalletUi() {
  const ctx = useContext(WalletUiContext)
  if (!ctx) throw new Error('WalletUiProvider missing')
  return ctx
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function ConnectButton() {
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const { setOpen } = useWalletUi()

  if (isConnected && address) {
    return (
      <button type="button" className="connect-btn addr" onClick={() => disconnect()} title={address}>
        {shortAddr(address)}
      </button>
    )
  }

  return (
    <button type="button" className="connect-btn" onClick={() => setOpen(true)}>
      Connect
    </button>
  )
}

export function ConnectModal() {
  const { open, setOpen } = useWalletUi()
  const { connect, isPending, error, reset } = useConnect()
  const connectors = useConnectors()
  const close = useCallback(() => {
    reset()
    setOpen(false)
  }, [reset, setOpen])

  if (!open) return null

  const named = connectors.filter((c) => c.id !== 'injected')
  const list = named.length ? named : connectors

  return (
    <div className="wc-overlay" onClick={close} role="presentation">
      <div
        className="wc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wc-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wc-head">
          <button type="button" className="wc-icon" aria-label="Help" onClick={() => window.open('https://ethereum.org/wallets/', '_blank')}>
            ?
          </button>
          <h2 id="wc-title">Connect Wallet</h2>
          <button type="button" className="wc-icon" aria-label="Close" onClick={close}>
            ✕
          </button>
        </div>

        {list.length === 0 ? (
          <p className="wc-empty">No browser wallet found. Install MetaMask, Rabby, or OKX and refresh.</p>
        ) : (
          <div className="wc-list">
            {list.map((connector) => {
              const icon = connector.icon
              const letter = connector.name.slice(0, 1).toUpperCase()
              return (
                <button
                  key={connector.uid}
                  type="button"
                  className="wc-row"
                  disabled={isPending}
                  onClick={() => {
                    connect(
                      { connector },
                      {
                        onSuccess: () => close(),
                      },
                    )
                  }}
                >
                  <span className="meta">
                    {connector.name}
                    {connector.type === 'injected' ? <span className="tag">Installed</span> : null}
                  </span>
                  {icon ? (
                    <img className="wc-logo" src={icon} alt="" />
                  ) : (
                    <span className="wc-logo fallback">{letter}</span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {error ? <p className="wc-err">{error.message}</p> : null}

        <p className="wc-foot">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19 7h-1V6a4 4 0 0 0-8 0v1H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2M10 6a2 2 0 1 1 4 0v1h-4Zm9 13H7V9h12Zm-6-3.5A1.5 1.5 0 0 1 11.5 14V12A1.5 1.5 0 0 1 13 10.5 1.5 1.5 0 0 1 14.5 12v2a1.5 1.5 0 0 1-1.5 1.5"
            />
          </svg>
          <a href="https://ethereum.org/wallets/find-wallet/" target="_blank" rel="noreferrer">
            I don&apos;t have a wallet
          </a>
        </p>
      </div>
    </div>
  )
}
