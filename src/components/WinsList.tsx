import { useEffect, useMemo, useState } from 'react'
import { formatUnits, getAddress, isAddress, parseAbiItem, type Address, type Hex, type Log } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { contracts, explorerUrl, tokenMeta } from '../config'

export type WinRow = {
  wallet: string
  mult: number
  amt: number
  jack?: boolean
  block: bigint
  index: number
  tx?: Hex
}

function txUrl(hash: Hex) {
  return `${explorerUrl}/tx/${hash}`
}

function sortWins(a: WinRow, b: WinRow) {
  if (a.block === b.block) return b.index - a.index
  return a.block < b.block ? 1 : -1
}

const MAX = 6
const SEARCH_MAX = 20

function rnd(a: number, b: number) {
  return a + Math.random() * (b - a)
}

function fakeWallet(): Address {
  const bytes = Array.from({ length: 20 }, () => Math.floor(Math.random() * 256))
  return getAddress(`0x${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`)
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function fakeWin(): WinRow {
  const roll = Math.random()
  let mult = 4
  if (roll < 0.5) mult = 0.9
  else if (roll < 0.72) mult = 1
  else if (roll < 0.86) mult = 1.5
  else if (roll < 0.94) mult = 2
  const sol = +rnd(0.2, 4.5).toFixed(2)
  return {
    wallet: fakeWallet(),
    mult,
    amt: Math.round(sol * 1000 * mult),
    block: 0n,
    index: 0,
  }
}

function fakeJack(): WinRow {
  return {
    wallet: fakeWallet(),
    mult: 0,
    amt: Math.round(rnd(2_400, 28_000)),
    jack: true,
    block: 1n,
    index: 1,
  }
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

function Row({ w, animate, pinned }: { w: WinRow; animate: boolean; pinned?: boolean }) {
  const hot = w.mult > 2 || Boolean(w.jack)
  const href = w.tx ? txUrl(w.tx) : undefined
  return (
    <div className={`win${w.jack ? ' is-jack' : ''}${pinned ? ' pin' : ''}`} style={animate ? undefined : { animation: 'none' }}>
      <p className="addr mono">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" title={`${w.wallet} · payout tx`}>
            {shortAddr(w.wallet)}
          </a>
        ) : (
          <span title={w.wallet}>{shortAddr(w.wallet)}</span>
        )}
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
      <Face mood={hot || Boolean(w.jack) ? 'happy' : 'neutral'} />
    </div>
  )
}

const settledEvent = parseAbiItem(
  'event RewardsSettled(uint256 indexed buyId, address indexed recipient, address indexed mainToken, uint256 multiplierWad, uint256 bonusPaid, uint256 roll)',
)
const hitEvent = parseAbiItem(
  'event JackpotHit(uint256 indexed buyId, address indexed recipient, uint256 winProbWad, uint256 roll, uint256 payout, uint256 target)',
)

function settledRow(log: Log<bigint, number, false, typeof settledEvent>): WinRow {
  const mult = Number(log.args.multiplierWad ?? 0n) / 1e18
  const bonus = Number(formatUnits(log.args.bonusPaid ?? 0n, tokenMeta.mainDecimals))
  return {
    wallet: log.args.recipient ?? '0x',
    mult: Math.round(mult * 10) / 10,
    amt: Math.round(bonus) || Math.round(mult * 1000),
    block: log.blockNumber ?? 0n,
    index: log.logIndex ?? 0,
    tx: log.transactionHash ?? undefined,
  }
}

function hitRow(log: Log<bigint, number, false, typeof hitEvent>): WinRow {
  return {
    wallet: log.args.recipient ?? '0x',
    mult: 0,
    amt: Math.round(Number(formatUnits(log.args.payout ?? 0n, tokenMeta.usdgDecimals))),
    jack: true,
    block: log.blockNumber ?? 0n,
    index: log.logIndex ?? 0,
    tx: log.transactionHash ?? undefined,
  }
}

async function fetchOnchainWins(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  recipient?: Address,
): Promise<{ rows: WinRow[]; lastJack: WinRow | null } | null> {
  try {
    const latest = await client.getBlockNumber()
    const lookback = recipient ? 200_000n : 80_000n
    const from = latest > lookback ? latest - lookback : 0n
    const args = recipient ? { recipient } : undefined
    const [settled, hits] = await Promise.all([
      client.getLogs({
        address: contracts.rewards,
        event: settledEvent,
        args,
        fromBlock: from,
        toBlock: latest,
      }),
      client.getLogs({
        address: contracts.jackpot,
        event: hitEvent,
        args,
        fromBlock: from,
        toBlock: latest,
      }),
    ])
    const jackRows = hits.map(hitRow).sort(sortWins)
    const lastJack = jackRows[0] ?? null
    const regular = settled.map(settledRow).sort(sortWins)
    if (recipient) {
      return { rows: [...jackRows, ...regular].sort(sortWins).slice(0, SEARCH_MAX), lastJack }
    }
    return { rows: regular.slice(0, lastJack ? MAX - 1 : MAX), lastJack }
  } catch {
    return null
  }
}

export function WinsList() {
  const client = usePublicClient()
  const { address } = useAccount()
  const [rows, setRows] = useState<WinRow[]>(() => Array.from({ length: 5 }, () => fakeWin()))
  const [lastJack, setLastJack] = useState<WinRow | null>(() => fakeJack())
  const [found, setFound] = useState<WinRow[] | null>(null)
  const [onchain, setOnchain] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)

  const trimmed = query.trim()
  const looking = trimmed.length > 0

  useEffect(() => {
    if (!client) return
    let cancelled = false
    fetchOnchainWins(client).then((got) => {
      if (cancelled || !got || (got.rows.length === 0 && !got.lastJack)) return
      setOnchain(true)
      setLastJack(got.lastJack ?? fakeJack())
      setRows(got.rows)
    })
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => {
    if (onchain || looking) return
    const t = window.setTimeout(function tick() {
      setRows((prev) => [fakeWin(), ...prev].slice(0, MAX - 1))
      window.setTimeout(tick, 2800 + Math.random() * 4200)
    }, 3200)
    return () => clearTimeout(t)
  }, [onchain, looking])

  useEffect(() => {
    if (!looking) {
      setFound(null)
      setSearching(false)
      return
    }
    if (!client || !isAddress(trimmed)) {
      setFound(null)
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    fetchOnchainWins(client, getAddress(trimmed)).then((got) => {
      if (cancelled) return
      setSearching(false)
      setFound(got?.rows ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [client, looking, trimmed])

  const list = useMemo(() => {
    const board = lastJack
      ? [lastJack, ...rows.filter((w) => !sameWin(w, lastJack))].slice(0, MAX)
      : rows.slice(0, MAX)
    if (!looking) return board
    const local = board.filter((w) => matchesWallet(w.wallet, trimmed))
    if (isAddress(trimmed)) {
      if (found != null && found.length > 0) return found
      if (onchain && found != null) return []
      return local.slice(0, SEARCH_MAX)
    }
    return local.slice(0, SEARCH_MAX)
  }, [found, lastJack, looking, onchain, rows, trimmed])

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
        {searching ? <p className="wins-empty">looking…</p> : null}
        {!searching && looking && list.length === 0 ? (
          <p className="wins-empty">No wins for this wallet yet.</p>
        ) : null}
        {!searching
          ? list.map((w, i) => (
              <Row
                key={`${w.wallet}-${w.tx ?? w.block}-${w.index}-${i}`}
                w={w}
                animate={!looking && i === 0 && !w.jack}
                pinned={!looking && lastJack != null && Boolean(w.jack) && sameWin(w, lastJack)}
              />
            ))
          : null}
      </div>
    </div>
  )
}
