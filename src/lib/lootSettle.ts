import {
  formatUnits,
  parseAbiItem,
  parseEventLogs,
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
const MIN_BUY_USDG = 1_000_000n
const QUICKNET_GENESIS = 1_692_803_367
const QUICKNET_PERIOD = 3

const ticketOpenedLegacy = parseAbiItem(
  'event TicketOpened(uint256 indexed buyId, uint256 indexed listingId, address mainToken, uint256 mainAmountOut)',
)

export class LootTimeoutError extends Error {
  constructor() {
    super('Loot settle timed out')
    this.name = 'LootTimeoutError'
  }
}

export type BuyTicket =
  | { kind: 'none' }
  | { kind: 'skipped'; buyId: bigint }
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
      return (sig.startsWith('0x') ? sig : `0x${sig}`) as Hex
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

function openFromBuy(
  buyId: bigint,
  mainAmountOut: bigint,
  feeMainTaken: bigint,
  targetDrandRound: bigint,
): Extract<BuyTicket, { kind: 'open' }> {
  return { kind: 'open', buyId, mainAmountOut, feeMainTaken, targetDrandRound }
}

export function parseBuyTicket(logs: Log[]): BuyTicket {
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
    return { kind: 'skipped', buyId: skipped[0].args.buyId }
  }

  const buy = buys[0]
  if (buy?.args.buyId != null) {
    if ((buy.args.quoteAmountIn ?? 0n) < MIN_BUY_USDG) {
      return { kind: 'skipped', buyId: buy.args.buyId }
    }
    return openFromBuy(buy.args.buyId, buy.args.mainAmountOut ?? 0n, buy.args.feeMainTaken ?? 0n, 0n)
  }

  return { kind: 'none' }
}

export function parseBuyTicketFromReceipt(receipt: TransactionReceipt): BuyTicket {
  return parseBuyTicket(receipt.logs)
}

function sameTx(hash: Hex | null | undefined, tx: Hex) {
  return hash != null && hash.toLowerCase() === tx.toLowerCase()
}

/** Re-read hook/rewards logs if the swap receipt omitted them. */
export async function recoverBuyTicket(client: PublicClient, receipt: TransactionReceipt): Promise<BuyTicket> {
  const first = parseBuyTicketFromReceipt(receipt)
  if (first.kind !== 'none') return first
  if (receipt.blockNumber == null) return first

  try {
    const [opened, skipped, buys] = await Promise.all([
      client.getContractEvents({
        address: contracts.rewards,
        abi: rewardsCollectorAbi,
        eventName: 'TicketOpened',
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
        open.args.targetDrandRound ?? 0n,
      )
    }
    const skip = skipped.find((l) => sameTx(l.transactionHash, tx))
    if (skip?.args.buyId != null) return { kind: 'skipped', buyId: skip.args.buyId }
    const buy = buys.find((l) => sameTx(l.transactionHash, tx))
    if (buy?.args.buyId != null) {
      if ((buy.args.quoteAmountIn ?? 0n) < MIN_BUY_USDG) {
        return { kind: 'skipped', buyId: buy.args.buyId }
      }
      return openFromBuy(buy.args.buyId, buy.args.mainAmountOut ?? 0n, buy.args.feeMainTaken ?? 0n, 0n)
    }
  } catch {
    /* RPC blip — keep first parse */
  }
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

async function readReady(client: PublicClient, buyId: bigint): Promise<boolean> {
  try {
    return await client.readContract({
      address: contracts.jackpot,
      abi: jackpotPoolAbi,
      functionName: 'isReadyToSettle',
      args: [buyId],
    })
  } catch {
    return false
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

    targetRound = await readTargetRound(opts.client, opts.buyId, targetRound)
    const readyOnchain = targetRound > 0n ? await readReady(opts.client, opts.buyId) : false
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
