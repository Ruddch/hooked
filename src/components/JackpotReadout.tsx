import { useEffect } from 'react'
import { formatUnits, zeroAddress } from 'viem'
import { useReadContract } from 'wagmi'
import { jackpotPoolAbi, hookedV1Abi } from '../abi/hooked'
import { contracts, explorerUrl, tokenMeta } from '../config'

function fmtUsd(n: number) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

/** Jackpot hit pays this share of `poolBalance`. */
const JACKPOT_PAYOUT_NUMERATOR = 1n
const JACKPOT_PAYOUT_DENOMINATOR = 2n

export function useJackpotUsd() {
  const listing = useReadContract({
    address: contracts.hook,
    abi: hookedV1Abi,
    functionName: 'listings',
    args: [contracts.listingId],
    query: { retry: false },
  })

  const jackpotFromListing = listing.data?.[2]
  const jackpotAddr =
    jackpotFromListing && jackpotFromListing !== zeroAddress ? jackpotFromListing : contracts.jackpot

  const pool = useReadContract({
    address: jackpotAddr,
    abi: jackpotPoolAbi,
    functionName: 'poolBalance',
    query: {
      enabled: Boolean(jackpotAddr && jackpotAddr !== zeroAddress),
      retry: false,
      refetchInterval: 15_000,
    },
  })

  const payout =
    pool.data != null ? (pool.data * JACKPOT_PAYOUT_NUMERATOR) / JACKPOT_PAYOUT_DENOMINATOR : null
  const usd = payout != null ? Number(formatUnits(payout, tokenMeta.usdgDecimals)) : null
  const live = pool.data != null && !pool.isError

  useEffect(() => {
    if (live && usd != null && usd > 0) {
      window.__setJackRevealTarget?.(usd)
    }
  }, [live, usd])

  return { usd, live, jackpotAddr }
}

export function JackpotReadout() {
  const { usd, live, jackpotAddr } = useJackpotUsd()
  const label = live && usd != null ? `$${fmtUsd(usd)}` : '—'
  const href =
    jackpotAddr && jackpotAddr !== zeroAddress ? `${explorerUrl}/address/${jackpotAddr}` : undefined

  return (
    <aside className="jackpot" id="jackpot" aria-label="Current jackpot">
      <div className="jtop">
        <p className="jl mono">
          current jackpot
          {href ? (
            <a className="tx" href={href} target="_blank" rel="noreferrer" title="View jackpot contract" aria-label="View jackpot contract">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.5M9 2.5h4.5V7M13.5 2.5 7 9"
                />
              </svg>
            </a>
          ) : null}
        </p>
        <p className="jv">
          <span className="sel">{label}</span>
        </p>
      </div>
      <p className="jd">{live ? 'Live pool. One roll can take it.' : 'Pool not wired yet. One roll can take it.'}</p>
    </aside>
  )
}
