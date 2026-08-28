import { formatUnits, parseAbiItem, type Hex, type Log, type PublicClient } from 'viem'
import { contracts, tokenMeta, winsFromBlock } from '../config'

export type WinRow = {
  wallet: string
  mult: number
  amt: number
  jack?: boolean
  block: bigint
  index: number
  tx?: Hex
}

const CACHE_KEY = 'hooked:wins:v1'
const CACHE_VER = 1
const CHUNK = 80_000n

const settledEvent = parseAbiItem(
  'event RewardsSettled(uint256 indexed buyId, address indexed recipient, address indexed mainToken, uint256 multiplierWad, uint256 bonusPaid, uint256 roll)',
)
const hitEvent = parseAbiItem(
  'event JackpotHit(uint256 indexed buyId, address indexed recipient, uint256 winProbWad, uint256 roll, uint256 payout, uint256 target)',
)

export function isListedWin(w: WinRow) {
  return Boolean(w.jack) || w.mult >= 1
}

export function winKey(w: WinRow) {
  return `${w.tx ?? ''}:${w.block}:${w.index}:${w.jack ? 'j' : 'r'}`
}

export function sortWins(a: WinRow, b: WinRow) {
  if (a.block === b.block) return b.index - a.index
  return a.block < b.block ? 1 : -1
}

export function mergeUnique(into: WinRow[], extra: WinRow[]) {
  const seen = new Set(into.map(winKey))
  for (const w of extra) {
    const k = winKey(w)
    if (seen.has(k)) continue
    seen.add(k)
    into.push(w)
  }
}

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

export async function logsInRange(client: PublicClient, fromBlock: bigint, toBlock: bigint | 'latest') {
  const [settled, hits] = await Promise.all([
    client.getLogs({
      address: contracts.rewards,
      event: settledEvent,
      args: { mainToken: contracts.mainToken },
      fromBlock,
      toBlock,
    }),
    client.getLogs({
      address: contracts.jackpot,
      event: hitEvent,
      fromBlock,
      toBlock,
    }),
  ])
  return {
    settled: settled.map(settledRow).filter(isListedWin),
    hits: hits.map(hitRow),
  }
}

type CachedWin = Omit<WinRow, 'block'> & { block: string }

type WinsCache = {
  v: number
  rewards: string
  jackpot: string
  mainToken: string
  fromBlock: string
  head: string
  wins: CachedWin[]
}

function toCached(w: WinRow): CachedWin {
  return { ...w, block: w.block.toString() }
}

function fromCached(w: CachedWin): WinRow {
  return { ...w, block: BigInt(w.block) }
}

export function loadWinsCache(): { head: bigint; wins: WinRow[] } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as WinsCache
    if (
      parsed.v !== CACHE_VER ||
      parsed.rewards.toLowerCase() !== contracts.rewards.toLowerCase() ||
      parsed.jackpot.toLowerCase() !== contracts.jackpot.toLowerCase() ||
      parsed.mainToken.toLowerCase() !== contracts.mainToken.toLowerCase() ||
      parsed.fromBlock !== winsFromBlock.toString()
    ) {
      return null
    }
    const head = BigInt(parsed.head)
    if (head < winsFromBlock) return null
    return { head, wins: parsed.wins.map(fromCached) }
  } catch {
    return null
  }
}

export function saveWinsCache(head: bigint, wins: WinRow[]) {
  const payload: WinsCache = {
    v: CACHE_VER,
    rewards: contracts.rewards,
    jackpot: contracts.jackpot,
    mainToken: contracts.mainToken,
    fromBlock: winsFromBlock.toString(),
    head: head.toString(),
    wins: [...wins].sort(sortWins).map(toCached),
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload))
  } catch {
    /* quota / private mode */
  }
}

export async function pullWinsSince(opts: {
  client: PublicClient
  fromBlock: bigint
  aborted: () => boolean
  onBatch: (batch: { settled: WinRow[]; hits: WinRow[] }) => void
}): Promise<bigint | null> {
  const latest = await opts.client.getBlockNumber()
  if (opts.fromBlock > latest) return latest

  try {
    const all = await logsInRange(opts.client, opts.fromBlock, latest)
    if (opts.aborted()) return null
    opts.onBatch(all)
    return opts.aborted() ? null : await opts.client.getBlockNumber()
  } catch {
    /* range rejected — walk forward in windows */
  }

  let cursor = opts.fromBlock
  let head = latest
  while (!opts.aborted() && cursor <= head) {
    const end = cursor + CHUNK - 1n > head ? head : cursor + CHUNK - 1n
    try {
      const chunk = await logsInRange(opts.client, cursor, end)
      if (opts.aborted()) return null
      opts.onBatch(chunk)
    } catch {
      /* skip a bad window and keep walking */
    }
    cursor = end + 1n
    if (cursor > head) {
      try {
        head = await opts.client.getBlockNumber()
      } catch {
        break
      }
    }
  }
  return opts.aborted() ? null : head
}
