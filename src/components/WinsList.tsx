import { useEffect, useMemo, useRef, useState } from 'react'
import { getAddress, isAddress, type Hex } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { explorerUrl, winsFromBlock } from '../config'
import {
  loadWinsCache,
  logsInRange,
  mergeUnique,
  pullWinsSince,
  saveWinsCache,
  sortWins,
  winKey,
  type WinRow,
} from '../lib/winsHistory'

export type { WinRow }

function txUrl(hash: Hex) {
  return `${explorerUrl}/tx/${hash}`
}

const MAX = 6
const SEARCH_MAX = 20
const LIVE_MS = 10_000
const LIVE_OVERLAP = 128n

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function sameWin(a: WinRow, b: WinRow) {
  if (a.tx && b.tx) return a.tx === b.tx
  return a.wallet === b.wallet && a.block === b.block && a.index === b.index && Boolean(a.jack) === Boolean(b.jack)
}

function fmt(n: number) {
  return n.toLocaleString('en-US')
}

function matchesWallet(wallet: string, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const full = wallet.toLowerCase()
  const short = shortAddr(wallet).toLowerCase()
  if (isAddress(q)) return full === getAddress(q).toLowerCase()
  return full.includes(q) || short.includes(q.replace(/…/g, ''))
}

function Face({ mood }: { mood: 'happy' | 'neutral' }) {
  return (
    <div className="face-slot">
      <svg
        className="smiley"
        viewBox="0 0 156 156"
        data-mood={mood}
        data-base={mood === 'happy' ? '#00D4AA' : '#FFC107'}
        aria-hidden="true"
      />
    </div>
  )
}

function TxIcon() {
  return (
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
  )
}

function lastJackFrom(history: WinRow[]) {
  return history.filter((w) => w.jack).sort(sortWins)[0] ?? null
}

function boardFrom(history: WinRow[]) {
  const jack = lastJackFrom(history)
  const regular = history.filter((w) => !w.jack).sort(sortWins)
  const need = jack ? MAX - 1 : MAX
  return { jack, rows: regular.slice(0, need) }
}

function Row({ w, animate, pinned }: { w: WinRow; animate: boolean; pinned?: boolean }) {
  const hot = w.mult > 2 || Boolean(w.jack)
  const happy = w.mult > 1 || Boolean(w.jack)
  const href = w.tx ? txUrl(w.tx) : undefined
  return (
    <div className={`win${w.jack ? ' is-jack' : ''}${pinned ? ' pin' : ''}`} style={animate ? undefined : { animation: 'none' }}>
      <p className="addr mono">
        <span className="who">
          <span title={w.wallet}>{shortAddr(w.wallet)}</span>
          {href ? (
            <a className="tx" href={href} target="_blank" rel="noreferrer" title="View transaction" aria-label="View transaction">
              <TxIcon />
            </a>
          ) : null}
        </span>
        {pinned ? <span className="tag">last jackpot</span> : null}
      </p>
      <p className="pay">
        <b>{fmt(w.amt)}</b> {w.jack ? 'USDG' : '$HOOKED'}
        {href ? (
          <a className={`mx ${w.jack ? 'jack' : hot ? 'hot' : ''}`} href={href} target="_blank" rel="noreferrer">
            {w.jack ? 'JACK' : `${w.mult}×`}
          </a>
        ) : (
          <span className={`mx ${w.jack ? 'jack' : hot ? 'hot' : ''}`}>{w.jack ? 'JACK' : `${w.mult}×`}</span>
        )}
      </p>
      <Face mood={happy ? 'happy' : 'neutral'} />
    </div>
  )
}

export function WinsList() {
  const client = usePublicClient()
  const { address } = useAccount()
  const [history, setHistory] = useState<WinRow[]>(() => loadWinsCache()?.wins ?? [])
  const [ready, setReady] = useState(false)
  const [query, setQuery] = useState('')

  const trimmed = query.trim()
  const looking = trimmed.length > 0
  const headRef = useRef<bigint | null>(null)
  const historyRef = useRef<WinRow[]>([])
  const readyRef = useRef(false)

  historyRef.current = history
  readyRef.current = ready

  const { jack: lastJack, rows } = useMemo(() => boardFrom(history), [history])

  useEffect(() => {
    if (!client) return
    let cancelled = false
    const cached = loadWinsCache()
    if (cached) {
      headRef.current = cached.head
      historyRef.current = cached.wins
      setHistory(cached.wins)
    } else {
      headRef.current = null
      historyRef.current = []
      setHistory([])
    }

    const ingest = (settled: WinRow[], hits: WinRow[], head: bigint) => {
      const merged: WinRow[] = []
      mergeUnique(merged, settled)
      mergeUnique(merged, hits)
      mergeUnique(merged, historyRef.current)
      historyRef.current = merged
      headRef.current = head
      setHistory(merged)
      saveWinsCache(head, merged)
    }

    const catchUp = async () => {
      const from = headRef.current != null ? headRef.current + 1n : winsFromBlock
      const head = await pullWinsSince({
        client,
        fromBlock: from,
        aborted: () => cancelled,
        onBatch: ({ settled, hits }) => {
          if (cancelled) return
          const merged: WinRow[] = []
          mergeUnique(merged, settled)
          mergeUnique(merged, hits)
          mergeUnique(merged, historyRef.current)
          historyRef.current = merged
          setHistory(merged)
        },
      })
      if (cancelled) return
      if (head != null) {
        headRef.current = head
        saveWinsCache(head, historyRef.current)
      }
      setReady(true)
    }

    const liveTick = async () => {
      if (cancelled || document.hidden || !readyRef.current) return
      const from = headRef.current
      if (from == null) return
      const start = from > LIVE_OVERLAP ? from - LIVE_OVERLAP : winsFromBlock
      try {
        const chunk = await logsInRange(client, start, 'latest')
        if (cancelled) return
        const head = await client.getBlockNumber()
        if (cancelled) return
        const seen = new Set(historyRef.current.map(winKey))
        const fresh = [...chunk.settled, ...chunk.hits].filter((w) => !seen.has(winKey(w)))
        if (fresh.length === 0) {
          headRef.current = head
          saveWinsCache(head, historyRef.current)
          return
        }
        ingest(chunk.settled, chunk.hits, head)
      } catch {
        /* RPC blip — next tick retries */
      }
    }

    setReady(false)
    void catchUp().catch(() => {
      if (!cancelled) setReady(true)
    })

    const id = window.setInterval(() => {
      void liveTick()
    }, LIVE_MS)
    const onSettled = () => {
      void liveTick()
    }
    const onVis = () => {
      if (!document.hidden) void liveTick()
    }
    window.addEventListener('hooked:loot-settled', onSettled)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('hooked:loot-settled', onSettled)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [client])

  const list = useMemo(() => {
    if (looking) {
      const matched = history.filter((w) => matchesWallet(w.wallet, trimmed)).sort(sortWins)
      return isAddress(trimmed) ? matched : matched.slice(0, SEARCH_MAX)
    }
    const jack = lastJack
    return jack ? [jack, ...rows.filter((w) => !sameWin(w, jack))].slice(0, MAX) : rows.slice(0, MAX)
  }, [history, lastJack, looking, rows, trimmed])

  useEffect(() => {
    const bind = window.__bindSmiley
    if (!bind) return
    document.querySelectorAll('#winsList .smiley').forEach((sv) => bind(sv as SVGElement))
  }, [list])

  return (
    <div className="wins-board">
      <div className="wins-find">
        <input
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="paste wallet"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find wins by wallet"
        />
        {address ? (
          <button type="button" className="me" onClick={() => setQuery(address)}>
            me
          </button>
        ) : null}
      </div>
      <div className="wins-list" id="winsList" aria-live="polite">
        {looking && list.length === 0 ? (
          <p className="wins-empty">{ready ? 'No wins for this wallet yet.' : 'looking…'}</p>
        ) : null}
        {!looking && list.length === 0 ? <p className="wins-empty">{ready ? 'No wins yet.' : 'looking…'}</p> : null}
        {list.map((w, i) => (
          <Row
            key={`${w.wallet}-${w.tx ?? w.block}-${w.index}-${i}`}
            w={w}
            animate={!looking && i === 0 && !w.jack}
            pinned={!looking && lastJack != null && Boolean(w.jack) && sameWin(w, lastJack)}
          />
        ))}
        {looking && !ready && list.length > 0 ? <p className="wins-empty">looking…</p> : null}
      </div>
    </div>
  )
}
