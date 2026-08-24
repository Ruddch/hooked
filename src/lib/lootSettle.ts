import {
  formatUnits,
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

export function parseBuyTicket(logs: Log[]): BuyTicket {
  const opened = parseEventLogs({
    abi: rewardsCollectorAbi,
    logs,
    eventName: 'TicketOpened',
  })
  if (opened[0]?.args.buyId != null) {
    const buys = parseEventLogs({
      abi: hookedV1Abi,
      logs,
      eventName: 'BuyFeeRecorded',
    })
    const buy = buys.find((l) => l.args.buyId === opened[0].args.buyId) ?? buys[0]
    return {
      kind: 'open',
      buyId: opened[0].args.buyId,
      mainAmountOut: buy?.args.mainAmountOut ?? opened[0].args.mainAmountOut ?? 0n,
      feeMainTaken: buy?.args.feeMainTaken ?? 0n,
    }
  }

  const skipped = parseEventLogs({
    abi: rewardsCollectorAbi,
    logs,
    eventName: 'TicketSkipped',
  })
  if (skipped[0]?.args.buyId != null) {
    return { kind: 'skipped', buyId: skipped[0].args.buyId }
  }

  return { kind: 'none' }
}

export function parseBuyTicketFromReceipt(receipt: TransactionReceipt): BuyTicket {
  return parseBuyTicket(receipt.logs)
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

export async function waitForLootSettle(opts: {
  client: PublicClient
  buyId: bigint
  fromBlock: bigint
  signal?: AbortSignal
  timeoutMs?: number
  intervalMs?: number
}): Promise<LootSettle> {
  const timeoutMs = opts.timeoutMs ?? LOOT_SETTLE_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? LOOT_SETTLE_POLL_MS
  const deadline = Date.now() + timeoutMs

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

    const wait = Math.max(200, Math.min(intervalMs, deadline - Date.now()))
    await new Promise<void>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const t = window.setTimeout(resolve, wait)
      opts.signal?.addEventListener(
        'abort',
        () => {
          window.clearTimeout(t)
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
    })
  }
}
