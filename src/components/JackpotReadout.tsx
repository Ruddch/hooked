import { useEffect } from 'react'
import { formatUnits, zeroAddress } from 'viem'
import { useReadContract } from 'wagmi'
import { jackpotPoolAbi, hookedV1Abi } from '../abi/hooked'
import { contracts, tokenMeta } from '../config'

function fmtUsd(n: number) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

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

  const usd = pool.data != null ? Number(formatUnits(pool.data, tokenMeta.usdgDecimals)) : null
  const live = pool.data != null && !pool.isError

  useEffect(() => {
    if (live && usd != null && usd > 0) {
      window.__setJackRevealTarget?.(usd)
    }
  }, [live, usd])

  return { usd, live, jackpotAddr }
}

export function JackpotReadout() {
  const { usd, live } = useJackpotUsd()
  const label = live && usd != null ? `$${fmtUsd(usd)}` : '—'

  return (
    <aside className="jackpot" id="jackpot" aria-label="Current jackpot">
      <div className="jtop">
        <p className="jl mono">current jackpot</p>
        <p className="jv">
          <span className="sel">{label}</span>
        </p>
      </div>
      <p className="jd">{live ? 'Live pool. One roll can take it.' : 'Pool not wired yet. One roll can take it.'}</p>
    </aside>
  )
}
