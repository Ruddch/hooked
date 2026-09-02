import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAddress, isAddress, UserRejectedRequestError, type Address } from 'viem'
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { jackpotPoolAbi } from '../abi/hooked'
import { robinhood } from '../chain'
import { contracts } from '../config'
import {
  currentDrandRound,
  fetchDrandSignature,
  fetchResolvableFor,
  TICKET_READY,
  TICKET_WAITING,
  type ResolvableTicket,
} from '../lib/lootSettle'
import { useWalletUi } from './ConnectWallet'

const POLL_MS = 2_000

function shortId(id: bigint) {
  return `#${id.toString()}`
}

function rejected(e: unknown) {
  return (
    e instanceof UserRejectedRequestError ||
    (e instanceof Error && /user rejected|denied|rejected the request/i.test(e.message))
  )
}

function statusLabel(t: ResolvableTicket, nowRound: bigint) {
  if (t.state === TICKET_READY) return 'ready'
  if (t.state !== TICKET_WAITING) return 'open'
  if (t.targetDrandRound > nowRound) {
    const sec = Number(t.targetDrandRound - nowRound) * 3
    return `waiting ~${sec}s`
  }
  return 'waiting for oracle…'
}

function groupByRound(tickets: ResolvableTicket[]) {
  const groups = new Map<bigint, bigint[]>()
  for (const t of tickets) {
    const ids = groups.get(t.targetDrandRound) ?? []
    ids.push(t.buyId)
    groups.set(t.targetDrandRound, ids)
  }
  return groups
}

export function OpenRounds() {
  const client = usePublicClient({ chainId: robinhood.id })
  const { address, isConnected, chainId } = useAccount()
  const { setOpen } = useWalletUi()
  const { switchChainAsync, isPending: switching } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const [query, setQuery] = useState('')
  const [tickets, setTickets] = useState<ResolvableTicket[]>([])
  const [looking, setLooking] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [nowRound, setNowRound] = useState(() => currentDrandRound())
  const walletRef = useRef<Address | null>(null)

  const wallet = useMemo(() => {
    const q = query.trim()
    return isAddress(q) ? getAddress(q) : null
  }, [query])
  walletRef.current = wallet

  const readyTickets = useMemo(() => tickets.filter((t) => t.state === TICKET_READY), [tickets])
  const onRightChain = chainId === robinhood.id
  const busy = busyKey != null || switching

  const pull = useCallback(async () => {
    const who = walletRef.current
    if (!client || !who) {
      setTickets([])
      setLooking(false)
      return
    }
    try {
      const next = await fetchResolvableFor(client, who, undefined, true)
      if (walletRef.current !== who) return
      setTickets([...next].sort((a, b) => (a.buyId < b.buyId ? 1 : -1)))
      setErr(null)
    } catch (e) {
      if (walletRef.current !== who) return
      setErr(e instanceof Error ? e.message : 'Could not load open rounds')
    } finally {
      if (walletRef.current === who) setLooking(false)
    }
  }, [client])

  useEffect(() => {
    if (!wallet) {
      setTickets([])
      setLooking(false)
      setErr(null)
      return
    }
    setLooking(true)
    setErr(null)
    const t = window.setTimeout(() => {
      void pull()
    }, 180)
    return () => window.clearTimeout(t)
  }, [wallet, pull])

  useEffect(() => {
    if (!wallet) return
    const id = window.setInterval(() => {
      if (document.hidden) return
      void pull()
    }, POLL_MS)
    const onSettled = () => {
      void pull()
    }
    window.addEventListener('hooked:loot-settled', onSettled)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('hooked:loot-settled', onSettled)
    }
  }, [wallet, pull])

  useEffect(() => {
    if (tickets.every((t) => t.state === TICKET_READY)) return
    const id = window.setInterval(() => setNowRound(currentDrandRound()), 1_000)
    return () => window.clearInterval(id)
  }, [tickets])

  const ensureWallet = async () => {
    if (!isConnected) {
      setOpen(true)
      return false
    }
    if (!onRightChain) {
      await switchChainAsync({ chainId: robinhood.id })
    }
    return true
  }

  const settleGroup = async (round: bigint, buyIds: bigint[]) => {
    if (!client) throw new Error('No RPC')
    const signature = await fetchDrandSignature(round)
    const hash =
      buyIds.length === 1
        ? await writeContractAsync({
            address: contracts.jackpot,
            abi: jackpotPoolAbi,
            functionName: 'settleWithDrand',
            args: [buyIds[0], round, signature],
          })
        : await writeContractAsync({
            address: contracts.jackpot,
            abi: jackpotPoolAbi,
            functionName: 'settleBatchWithDrand',
            args: [buyIds, round, signature],
          })
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status === 'reverted') throw new Error('Resolve reverted')
  }

  const resolve = async (subset: ResolvableTicket[], key: string) => {
    setErr(null)
    try {
      if (!(await ensureWallet())) return
      setBusyKey(key)
      for (const [round, buyIds] of groupByRound(subset)) {
        await settleGroup(round, buyIds)
      }
      window.dispatchEvent(new CustomEvent('hooked:loot-settled'))
      await pull()
    } catch (e) {
      if (!rejected(e) && e instanceof Error) setErr(e.message)
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="open-board">
      <div className="wins-find">
        <input
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="paste wallet"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find open rounds by wallet"
        />
        {address ? (
          <button type="button" className="me" onClick={() => setQuery(address)}>
            me
          </button>
        ) : null}
        {readyTickets.length > 1 ? (
          <button
            type="button"
            className="resolve"
            disabled={busy}
            onClick={() => void resolve(readyTickets, 'all')}
          >
            {busyKey === 'all' ? 'Resolving…' : `Resolve ${readyTickets.length}`}
          </button>
        ) : null}
      </div>
      <div className="open-list" aria-live="polite">
        {!wallet ? <p className="wins-empty">Paste a wallet to find open rolls.</p> : null}
        {wallet && looking && tickets.length === 0 ? <p className="wins-empty">looking…</p> : null}
        {wallet && !looking && tickets.length === 0 ? (
          <p className="wins-empty">No open rounds for this wallet.</p>
        ) : null}
        {tickets.map((t) => {
          const ready = t.state === TICKET_READY
          const key = t.buyId.toString()
          return (
            <div key={key} className={`open-row${ready ? ' is-ready' : ''}`}>
              <p className="meta mono">
                <span>{shortId(t.buyId)}</span>
                <span>round {t.targetDrandRound.toString()}</span>
              </p>
              <p className={`st ${ready ? 'ready' : 'wait'}`}>{statusLabel(t, nowRound)}</p>
              <button
                type="button"
                className="resolve"
                disabled={!ready || busy}
                onClick={() => void resolve([t], key)}
              >
                {busyKey === key ? 'Resolving…' : 'Resolve'}
              </button>
            </div>
          )
        })}
      </div>
      {err ? <p className="open-err">{err}</p> : null}
    </div>
  )
}
