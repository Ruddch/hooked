import {
  bytesToHex,
  formatUnits,
  hexToBytes,
  parseAbiItem,
  parseEventLogs,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'
import { hookedV1Abi, jackpotPoolAbi, rewardsCollectorAbi } from '../abi/hooked'
import { contracts, tokenMeta } from '../config'

/** Must stay aligned with `POCKETS` in `fx/homeFx.ts`. */
const TIER_WADS = [
  900000000000000000n,
  1000000000000000000n,
  1500000000000000000n,
  2000000000000000000n,
  4000000000000000000n,
] as const

export const LOOT_SETTLE_TIMEOUT_MS = 180_000
export const LOOT_SETTLE_POLL_MS = 1_600
/** Wait for the keeper after the oracle round is live, then ask the user to settle. */
export const LOOT_KEEPER_GRACE_MS = 20_000
/** Used only if `minBuyUsdg()` is unreachable. */
export const MIN_BUY_USDG_FALLBACK = 10_000_000n
const QUICKNET_GENESIS = 1_692_803_367
const QUICKNET_PERIOD = 3

const RESOLVABLE_PAGE = 1000n
/** Queue states from `getResolvableFor`. Resolved / Expired are omitted. */
export const TICKET_WAITING = 2
export const TICKET_READY = 3

const ticketOpenedMid = parseAbiItem(
  'event TicketOpened(uint256 indexed buyId, uint256 indexed listingId, address mainToken, uint256 mainAmountOut, uint64 targetDrandRound)',
)
const ticketOpenedLegacy = parseAbiItem(
  'event TicketOpened(uint256 indexed buyId, uint256 indexed listingId, address mainToken, uint256 mainAmountOut)',
)

export type ResolvableTicket = {
  buyId: bigint
  targetDrandRound: bigint
  openedAt: bigint
  state: number
}

export class LootTimeoutError extends Error {
  constructor() {
    super('Loot settle timed out')
    this.name = 'LootTimeoutError'
  }
}

export type BuyTicket =
  | { kind: 'none' }
  | { kind: 'skipped'; buyId: bigint; minBuyUsdg?: bigint }
  | {
      kind: 'open'
      buyId: bigint
      mainAmountOut: bigint
      feeMainTaken: bigint
      targetDrandRound: bigint
    }

export type LootSettle = {
  multiplierWad: bigint
  bonusPaid: bigint
  jackpot: boolean
  jackpotPayout: bigint
  jackpotTarget: bigint
  settleTx?: Hex
}

export type LootDrop = {
  pocketIndex: number
  hookedOut: number
  jackpot: boolean
  jackpotUsd: number
}

export type LootWaitPhase = {
  targetRound: bigint
  ready: boolean
  confirming?: boolean
}

const DRAND_CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'
const DRAND_URLS = [
  `https://api.drand.sh/v2/chains/${DRAND_CHAIN}/rounds/`,
  `https://api.drand.sh/${DRAND_CHAIN}/public/`,
  `https://drand.cloudflare.com/${DRAND_CHAIN}/public/`,
]

export function currentDrandRound(ts = Math.floor(Date.now() / 1000)): bigint {
  if (ts < QUICKNET_GENESIS) return 0n
  return BigInt(Math.floor((ts - QUICKNET_GENESIS) / QUICKNET_PERIOD) + 1)
}

const BLS12_P =
  0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn

function modPow(base: bigint, exp: bigint, mod: bigint) {
  let r = 1n
  let b = ((base % mod) + mod) % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return r
}

/** Drand HTTP gives compressed G1 (48 bytes). The on-chain oracle wants uncompressed (96). */
function uncompressDrandSignature(sig: Hex): Hex {
  const hex = (sig.startsWith('0x') ? sig.slice(2) : sig).toLowerCase()
  if (hex.length === 192) return `0x${hex}` as Hex
  if (hex.length !== 96) throw new Error(`unexpected drand signature length ${hex.length / 2}`)
  const bytes = hexToBytes(`0x${hex}`)
  const head = bytes[0]
  if ((head & 0x40) !== 0) throw new Error('drand signature is infinity')
  const yLarger = (head & 0x20) !== 0
  bytes[0] = head & 0x1f
  const x = BigInt(bytesToHex(bytes))
  const y2 = (((x * x) % BLS12_P) * x + 4n) % BLS12_P
  let y = modPow(y2, (BLS12_P + 1n) / 4n, BLS12_P)
  if ((y * y) % BLS12_P !== y2) throw new Error('drand signature is not on curve')
  if (y + y > BLS12_P !== yLarger) y = (BLS12_P - y) % BLS12_P
  return `0x${x.toString(16).padStart(96, '0')}${y.toString(16).padStart(96, '0')}` as Hex
}

export async function fetchDrandSignature(round: bigint): Promise<Hex> {
  const n = round.toString()
  let lastErr: unknown
  for (const base of DRAND_URLS) {
    try {
      const res = await fetch(`${base}${n}`, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`drand HTTP ${res.status}`)
      const body = (await res.json()) as { signature?: string }
      const sig = body.signature
      if (!sig) throw new Error('drand response missing signature')
      const raw = (sig.startsWith('0x') ? sig : `0x${sig}`) as Hex
      return uncompressDrandSignature(raw)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('drand signature fetch failed')
}

export function pocketIndexFromWad(wad: bigint): number {
  let best = 0
  let bestDist = wad > TIER_WADS[0] ? wad - TIER_WADS[0] : TIER_WADS[0] - wad
  for (let i = 1; i < TIER_WADS.length; i++) {
    const t = TIER_WADS[i]
    const dist = wad > t ? wad - t : t - wad
    if (dist < bestDist) {
      best = i
      bestDist = dist
    }
  }
  return best
}

function buyFeeLogs(logs: Log[]) {
  return parseEventLogs({
    abi: hookedV1Abi,
    logs,
    eventName: 'BuyFeeRecorded',
  })
}

export async function readMinBuyUsdg(client: PublicClient): Promise<bigint> {
  try {
    return await client.readContract({
      address: contracts.rewards,
      abi: rewardsCollectorAbi,
      functionName: 'minBuyUsdg',
    })
  } catch {
    return MIN_BUY_USDG_FALLBACK
  }
}

export async function fetchResolvableFor(
  client: PublicClient,
  buyer: Address,
  aroundId?: bigint,
  full = false,
): Promise<ResolvableTicket[]> {
  const upper = await client.readContract({
    address: contracts.jackpot,
    abi: jackpotPoolAbi,
    functionName: 'resolvableUpperBound',
  })
  if (upper <= 1n) return []

  let from = 1n
  if (!full) {
    from = upper > RESOLVABLE_PAGE ? upper - RESOLVABLE_PAGE : 1n
    if (aroundId != null && aroundId > 0n && aroundId < from) from = aroundId
  }

  const out: ResolvableTicket[] = []
  while (from < upper) {
    const [tickets, nextId] = await client.readContract({
      address: contracts.jackpot,
      abi: jackpotPoolAbi,
      functionName: 'getResolvableFor',
      args: [buyer, from, RESOLVABLE_PAGE],
    })
    for (const t of tickets) {
      out.push({
        buyId: t.buyId,
        targetDrandRound: BigInt(t.targetDrandRound),
        openedAt: BigInt(t.openedAt),
        state: Number(t.state),
      })
    }
    if (nextId === 0n || nextId <= from || nextId >= upper) break
    from = nextId
  }
  return out
}

function newestResolvable(tickets: ResolvableTicket[]) {
  let best: ResolvableTicket | null = null
  for (const t of tickets) {
    if (!best || t.buyId > best.buyId) best = t
  }
  return best
}

function openFromBuy(
  buyId: bigint,
  mainAmountOut: bigint,
  feeMainTaken: bigint,
  targetDrandRound: bigint,
): Extract<BuyTicket, { kind: 'open' }> {
  return { kind: 'open', buyId, mainAmountOut, feeMainTaken, targetDrandRound }
}

export function parseBuyTicket(logs: Log[], minBuyUsdg = MIN_BUY_USDG_FALLBACK): BuyTicket {
  const buys = buyFeeLogs(logs)
  const opened = parseEventLogs({
    abi: rewardsCollectorAbi,
    logs,
    eventName: 'TicketOpened',
  })
  if (opened[0]?.args.buyId != null) {
    const buy = buys.find((l) => l.args.buyId === opened[0].args.buyId) ?? buys[0]
    return openFromBuy(
      opened[0].args.buyId,
      buy?.args.mainAmountOut ?? opened[0].args.mainAmountOut ?? 0n,
      buy?.args.feeMainTaken ?? 0n,
      opened[0].args.targetDrandRound ?? 0n,
    )
  }

  const mid = parseEventLogs({
    abi: [ticketOpenedMid],
    logs,
    eventName: 'TicketOpened',
  })
  if (mid[0]?.args.buyId != null) {
    const buy = buys.find((l) => l.args.buyId === mid[0].args.buyId) ?? buys[0]
    return openFromBuy(
      mid[0].args.buyId,
      buy?.args.mainAmountOut ?? mid[0].args.mainAmountOut ?? 0n,
      buy?.args.feeMainTaken ?? 0n,
      mid[0].args.targetDrandRound ?? 0n,
    )
  }

  const legacy = parseEventLogs({
    abi: [ticketOpenedLegacy],
    logs,
    eventName: 'TicketOpened',
  })
  if (legacy[0]?.args.buyId != null) {
    const buy = buys.find((l) => l.args.buyId === legacy[0].args.buyId) ?? buys[0]
    return openFromBuy(
      legacy[0].args.buyId,
      buy?.args.mainAmountOut ?? legacy[0].args.mainAmountOut ?? 0n,
      buy?.args.feeMainTaken ?? 0n,
      0n,
    )
  }

  const skipped = parseEventLogs({
    abi: rewardsCollectorAbi,
    logs,
    eventName: 'TicketSkipped',
  })
  if (skipped[0]?.args.buyId != null) {
    return { kind: 'skipped', buyId: skipped[0].args.buyId, minBuyUsdg: skipped[0].args.minBuyUsdg ?? minBuyUsdg }
  }

  const buy = buys[0]
  if (buy?.args.buyId != null) {
    if ((buy.args.quoteAmountIn ?? 0n) < minBuyUsdg) {
      return { kind: 'skipped', buyId: buy.args.buyId, minBuyUsdg }
    }
    return openFromBuy(buy.args.buyId, buy.args.mainAmountOut ?? 0n, buy.args.feeMainTaken ?? 0n, 0n)
  }

  return { kind: 'none' }
}

export function parseBuyTicketFromReceipt(receipt: TransactionReceipt, minBuyUsdg = MIN_BUY_USDG_FALLBACK): BuyTicket {
  return parseBuyTicket(receipt.logs, minBuyUsdg)
}

function sameTx(hash: Hex | null | undefined, tx: Hex) {
  return hash != null && hash.toLowerCase() === tx.toLowerCase()
}

/** Re-read hook/rewards logs if the swap receipt omitted them. Queue is the fallback when TicketOpened topic0 changed. */
export async function recoverBuyTicket(
  client: PublicClient,
  receipt: TransactionReceipt,
  buyer?: Address,
  minBuyUsdg?: bigint,
): Promise<BuyTicket> {
  const minBuy = minBuyUsdg ?? (await readMinBuyUsdg(client))
  const first = parseBuyTicketFromReceipt(receipt, minBuy)
  if (first.kind === 'skipped') return first
  if (first.kind === 'open' && first.targetDrandRound > 0n) return first

  const queued = buyer
    ? await fetchResolvableFor(client, buyer, first.kind === 'open' ? first.buyId : undefined).catch(() => [])
    : []
  const queuedMatch =
    first.kind === 'open' ? queued.find((t) => t.buyId === first.buyId) : newestResolvable(queued)

  if (first.kind === 'open') {
    if (first.targetDrandRound > 0n) return first
    if (queuedMatch && queuedMatch.targetDrandRound > 0n) {
      return { ...first, targetDrandRound: queuedMatch.targetDrandRound }
    }
  }

  if (receipt.blockNumber == null) {
    if (first.kind === 'open') return first
    if (queuedMatch) return openFromBuy(queuedMatch.buyId, 0n, 0n, queuedMatch.targetDrandRound)
    return first
  }

  try {
    const [opened, skipped, buys] = await Promise.all([
      client.getContractEvents({
        address: contracts.rewards,
        abi: rewardsCollectorAbi,
        eventName: 'TicketOpened',
        args: buyer ? { buyer } : undefined,
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      }),
      client.getContractEvents({
        address: contracts.rewards,
        abi: rewardsCollectorAbi,
        eventName: 'TicketSkipped',
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      }),
      client.getContractEvents({
        address: contracts.hook,
        abi: hookedV1Abi,
        eventName: 'BuyFeeRecorded',
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      }),
    ])
    const tx = receipt.transactionHash
    const open = opened.find((l) => sameTx(l.transactionHash, tx))
    if (open?.args.buyId != null) {
      const buy = buys.find((l) => sameTx(l.transactionHash, tx) && l.args.buyId === open.args.buyId) ?? buys.find((l) => sameTx(l.transactionHash, tx))
      return openFromBuy(
        open.args.buyId,
        buy?.args.mainAmountOut ?? open.args.mainAmountOut ?? 0n,
        buy?.args.feeMainTaken ?? 0n,
        open.args.targetDrandRound ?? queuedMatch?.targetDrandRound ?? 0n,
      )
    }
    const skip = skipped.find((l) => sameTx(l.transactionHash, tx))
    if (skip?.args.buyId != null) {
      return { kind: 'skipped', buyId: skip.args.buyId, minBuyUsdg: skip.args.minBuyUsdg ?? minBuy }
    }
    const buy = buys.find((l) => sameTx(l.transactionHash, tx))
    if (buy?.args.buyId != null) {
      if ((buy.args.quoteAmountIn ?? 0n) < minBuy) {
        return { kind: 'skipped', buyId: buy.args.buyId, minBuyUsdg: minBuy }
      }
      const round =
        queued.find((t) => t.buyId === buy.args.buyId)?.targetDrandRound ?? queuedMatch?.targetDrandRound ?? 0n
      return openFromBuy(buy.args.buyId, buy.args.mainAmountOut ?? 0n, buy.args.feeMainTaken ?? 0n, round)
    }
  } catch {
    /* RPC blip — keep first parse */
  }

  if (first.kind === 'open') return first
  if (queuedMatch) return openFromBuy(queuedMatch.buyId, 0n, 0n, queuedMatch.targetDrandRound)
  return first
}

export function toLootDrop(ticket: Extract<BuyTicket, { kind: 'open' }>, settle: LootSettle): LootDrop {
  const net = ticket.mainAmountOut > ticket.feeMainTaken ? ticket.mainAmountOut - ticket.feeMainTaken : 0n
  const hookedOut = Number(formatUnits(net + settle.bonusPaid, tokenMeta.mainDecimals))
  const jackpotUsd = Number(formatUnits(settle.jackpotPayout, tokenMeta.usdgDecimals))
  return {
    pocketIndex: pocketIndexFromWad(settle.multiplierWad),
    hookedOut: Number.isFinite(hookedOut) ? hookedOut : 0,
    jackpot: settle.jackpot,
    jackpotUsd: Number.isFinite(jackpotUsd) ? jackpotUsd : 0,
  }
}

function sameId(a: bigint | undefined, b: bigint) {
  return a != null && a === b
}

function lootFromSettleLogs(
  buyId: bigint,
  logs: Log[],
  tx?: Hex | null,
): LootSettle | null {
  const settled = parseEventLogs({
    abi: rewardsCollectorAbi,
    logs,
    eventName: 'RewardsSettled',
  })
  const match = settled.find((l) => sameId(l.args.buyId, buyId)) ?? settled[0]
  if (!sameId(match?.args.buyId, buyId) || match.args.multiplierWad == null) return null

  const hits = parseEventLogs({
    abi: jackpotPoolAbi,
    logs,
    eventName: 'JackpotHit',
  })
  const hit = hits.find((l) => sameId(l.args.buyId, buyId))
  return {
    multiplierWad: match.args.multiplierWad,
    bonusPaid: match.args.bonusPaid ?? 0n,
    jackpot: Boolean(hit),
    jackpotPayout: hit?.args.payout ?? 0n,
    jackpotTarget: hit?.args.target ?? 0n,
    settleTx: match.transactionHash ?? tx ?? undefined,
  }
}

async function settleFromRewardsLog(
  client: PublicClient,
  buyId: bigint,
  fromBlock: bigint,
  log: {
    args: { buyId?: bigint; multiplierWad?: bigint; bonusPaid?: bigint }
    transactionHash?: Hex | null
  },
): Promise<LootSettle | null> {
  if (!sameId(log.args.buyId, buyId) || log.args.multiplierWad == null) return null

  const hash = log.transactionHash
  let jackpot = false
  let jackpotPayout = 0n
  let jackpotTarget = 0n

  const hits = await client.getContractEvents({
    address: contracts.jackpot,
    abi: jackpotPoolAbi,
    eventName: 'JackpotHit',
    args: { buyId },
    fromBlock,
    toBlock: 'latest',
  })
  const hit = hits.find((l) => sameId(l.args.buyId, buyId))
  if (hit) {
    jackpot = true
    jackpotPayout = hit.args.payout ?? 0n
    jackpotTarget = hit.args.target ?? 0n
  }

  return {
    multiplierWad: log.args.multiplierWad,
    bonusPaid: log.args.bonusPaid ?? 0n,
    jackpot,
    jackpotPayout,
    jackpotTarget,
    settleTx: hash ?? undefined,
  }
}

async function readTargetRound(client: PublicClient, buyId: bigint, fallback: bigint): Promise<bigint> {
  if (fallback > 0n) return fallback
  try {
    return await client.readContract({
      address: contracts.rewards,
      abi: rewardsCollectorAbi,
      functionName: 'rewardsTargetDrandRound',
      args: [buyId],
    })
  } catch {
    return fallback
  }
}

async function readQueueTicket(
  client: PublicClient,
  buyer: Address,
  buyId: bigint,
): Promise<ResolvableTicket | null> {
  try {
    const tickets = await fetchResolvableFor(client, buyer, buyId)
    return tickets.find((t) => t.buyId === buyId) ?? null
  } catch {
    return null
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const t = window.setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

export async function waitForLootSettle(opts: {
  client: PublicClient
  buyer: Address
  buyId: bigint
  fromBlock: bigint
  targetDrandRound?: bigint
  signal?: AbortSignal
  timeoutMs?: number
  intervalMs?: number
  keeperGraceMs?: number
  onPhase?: (phase: LootWaitPhase) => void
  submitSettle: (args: { buyId: bigint; round: bigint }) => Promise<TransactionReceipt | null>
}): Promise<LootSettle> {
  const timeoutMs = opts.timeoutMs ?? LOOT_SETTLE_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? LOOT_SETTLE_POLL_MS
  const keeperGraceMs = opts.keeperGraceMs ?? LOOT_KEEPER_GRACE_MS
  const deadline = Date.now() + timeoutMs
  let targetRound = opts.targetDrandRound ?? 0n
  let readySince: number | null = null
  let nextSelfSettle = Number.POSITIVE_INFINITY

  const emitPhase = (ready: boolean, confirming = false) => {
    opts.onPhase?.({ targetRound, ready, confirming })
  }

  emitPhase(false)

  while (true) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (Date.now() > deadline) throw new LootTimeoutError()

    try {
      const logs = await opts.client.getContractEvents({
        address: contracts.rewards,
        abi: rewardsCollectorAbi,
        eventName: 'RewardsSettled',
        args: { buyId: opts.buyId },
        fromBlock: opts.fromBlock,
        toBlock: 'latest',
      })
      const match = logs.find((l) => sameId(l.args.buyId, opts.buyId)) ?? logs[0]
      if (match) {
        const settle = await settleFromRewardsLog(opts.client, opts.buyId, opts.fromBlock, match)
        if (settle) return settle
      }
    } catch {
      /* RPC blip — retry until timeout */
    }

    const queued = await readQueueTicket(opts.client, opts.buyer, opts.buyId)
    if (queued && queued.targetDrandRound > 0n) targetRound = queued.targetDrandRound
    else targetRound = await readTargetRound(opts.client, opts.buyId, targetRound)

    const readyOnchain = queued?.state === TICKET_READY
    const ready = readyOnchain || (targetRound > 0n && currentDrandRound() >= targetRound)
    if (ready) {
      if (readySince == null) {
        readySince = Date.now()
        nextSelfSettle = readySince + keeperGraceMs
      }
    } else {
      readySince = null
      nextSelfSettle = Number.POSITIVE_INFINITY
    }
    emitPhase(ready)

    if (ready && targetRound > 0n && Date.now() >= nextSelfSettle) {
      emitPhase(true, true)
      try {
        const receipt = await opts.submitSettle({ buyId: opts.buyId, round: targetRound })
        if (receipt) {
          const fromReceipt = lootFromSettleLogs(opts.buyId, receipt.logs, receipt.transactionHash)
          if (fromReceipt) return fromReceipt
        }
        nextSelfSettle = Date.now() + keeperGraceMs
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e
        nextSelfSettle = Date.now() + 8_000
      }
      emitPhase(true, false)
    }

    const wait = Math.max(200, Math.min(intervalMs, deadline - Date.now()))
    await sleep(wait, opts.signal)
  }
}
