import { encodePacked, keccak256, pad, toHex, type Hex } from 'viem'

/** PoolManager `_pools` mapping slot — Uniswap v4 StateLibrary.POOLS_SLOT */
const POOLS_SLOT = pad(toHex(6n), { size: 32 }) as Hex
const Q96 = 1n << 96n
const BPS = 10_000n
const BUY_FEE_BPS = 1_000n
const SELL_FEE_BPS = 350n

export const poolManagerAbi = [
  {
    type: 'function',
    name: 'extsload',
    stateMutability: 'view',
    inputs: [{ name: 'slot', type: 'bytes32' }],
    outputs: [{ name: 'value', type: 'bytes32' }],
  },
] as const

export function poolStateSlot(poolId: Hex): Hex {
  return keccak256(encodePacked(['bytes32', 'bytes32'], [poolId, POOLS_SLOT]))
}

export function sqrtPriceX96FromSlot0(word: Hex): bigint {
  return BigInt(word) & ((1n << 160n) - 1n)
}

/** Spot exact-in quote. Buy: USDG→Main (zeroForOne). Sell: Main→USDG. Net after hook output fee. */
export function quoteExactIn(amountIn: bigint, sqrtPriceX96: bigint, zeroForOne: boolean) {
  if (amountIn <= 0n || sqrtPriceX96 === 0n) return { gross: 0n, net: 0n }
  const p = sqrtPriceX96
  const gross = zeroForOne
    ? ((amountIn * p) / Q96 * p) / Q96
    : ((amountIn * Q96) / p * Q96) / p
  const fee = zeroForOne ? BUY_FEE_BPS : SELL_FEE_BPS
  const net = gross - (gross * fee) / BPS
  return { gross, net }
}
