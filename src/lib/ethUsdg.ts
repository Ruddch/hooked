import {
  encodeAbiParameters,
  encodePacked,
  type Hex,
  type PublicClient,
} from 'viem'
import { contracts } from '../config'

export const universalRouterAbi = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

export const quoterV2Abi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const

/** Universal Router command bytes */
const CMD_V3_SWAP_EXACT_IN = 0x00
const CMD_WRAP_ETH = 0x0b
const CMD_V4_SWAP = 0x10

/** v4 Actions */
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06
const ACTION_SETTLE = 0x0b
const ACTION_TAKE_ALL = 0x0f

/** ActionConstants */
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as const
const CONTRACT_BALANCE = 1n << 255n
const OPEN_DELTA = 0n

export type EthUsdgQuote = {
  fee: number
  amountOut: bigint
}

/** Best Uniswap v3 WETH→USDG quote across configured fee tiers. */
export async function quoteEthToUsdg(
  client: PublicClient,
  amountIn: bigint,
  fees: readonly number[] = contracts.ethUsdgFees,
): Promise<EthUsdgQuote | null> {
  if (amountIn <= 0n) return null
  const results = await Promise.all(
    fees.map(async (fee) => {
      try {
        const { result } = await client.simulateContract({
          address: contracts.v3Quoter,
          abi: quoterV2Abi,
          functionName: 'quoteExactInputSingle',
          args: [
            {
              tokenIn: contracts.weth,
              tokenOut: contracts.usdg,
              amountIn,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
        const amountOut = result[0]
        return amountOut > 0n ? ({ fee, amountOut } satisfies EthUsdgQuote) : null
      } catch {
        return null
      }
    }),
  )
  let best: EthUsdgQuote | null = null
  for (const row of results) {
    if (!row) continue
    if (!best || row.amountOut > best.amountOut) best = row
  }
  return best
}

/** Slippage floor (bps). */
export function applySlippage(amount: bigint, bps: number) {
  if (amount <= 0n || bps <= 0) return amount
  return amount - (amount * BigInt(bps)) / 10_000n
}

export function ethGasReserve(balance: bigint): bigint {
  // One Universal Router tx — leave a little native for gas.
  const reserve = 500_000_000_000_000n // 0.0005 ETH
  return balance > reserve ? balance - reserve : 0n
}

export type EthBuyRoute = {
  commands: Hex
  inputs: Hex[]
  value: bigint
  deadline: bigint
}

/**
 * Single-tx Uniswap route: WRAP_ETH → v3 WETH/USDG → v4 USDG/$HOOKED (with Hooked hook).
 * Intermediate USDG stays on the router; V4 settles CONTRACT_BALANCE and swaps OPEN_DELTA.
 */
export function encodeEthBuyRoute(opts: {
  ethIn: bigint
  v3Fee: number
  minUsdgOut: bigint
  minHookedOut: bigint
  poolFee: number
  tickSpacing: number
  deadlineSec?: number
}): EthBuyRoute {
  const {
    ethIn,
    v3Fee,
    minUsdgOut,
    minHookedOut,
    poolFee,
    tickSpacing,
    deadlineSec = Math.floor(Date.now() / 1000) + 600,
  } = opts

  const path = encodePacked(
    ['address', 'uint24', 'address'],
    [contracts.weth, v3Fee, contracts.usdg],
  )

  const wrapInput = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [ADDRESS_THIS, ethIn],
  )

  const v3Input = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'bytes' },
      { type: 'bool' },
      { type: 'uint256[]' },
    ],
    [ADDRESS_THIS, ethIn, minUsdgOut, path, false, []],
  )

  const actions = encodePacked(
    ['uint8', 'uint8', 'uint8'],
    [ACTION_SETTLE, ACTION_SWAP_EXACT_IN_SINGLE, ACTION_TAKE_ALL],
  )

  const settleParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }],
    [contracts.usdg, CONTRACT_BALANCE, false],
  )

  const swapParams = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            type: 'tuple',
            name: 'poolKey',
            components: [
              { type: 'address', name: 'currency0' },
              { type: 'address', name: 'currency1' },
              { type: 'uint24', name: 'fee' },
              { type: 'int24', name: 'tickSpacing' },
              { type: 'address', name: 'hooks' },
            ],
          },
          { type: 'bool', name: 'zeroForOne' },
          { type: 'uint128', name: 'amountIn' },
          { type: 'uint128', name: 'amountOutMinimum' },
          { type: 'uint256', name: 'minHopPriceX36' },
          { type: 'bytes', name: 'hookData' },
        ],
      },
    ],
    [
      {
        poolKey: {
          currency0: contracts.usdg,
          currency1: contracts.mainToken,
          fee: poolFee,
          tickSpacing,
          hooks: contracts.hook,
        },
        zeroForOne: true,
        amountIn: OPEN_DELTA,
        amountOutMinimum: minHookedOut,
        minHopPriceX36: 0n,
        hookData: '0x',
      },
    ],
  )

  const takeParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [contracts.mainToken, minHookedOut],
  )

  const v4Input = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [settleParams, swapParams, takeParams]],
  )

  const commands = encodePacked(
    ['uint8', 'uint8', 'uint8'],
    [CMD_WRAP_ETH, CMD_V3_SWAP_EXACT_IN, CMD_V4_SWAP],
  )

  return {
    commands,
    inputs: [wrapInput, v3Input, v4Input],
    value: ethIn,
    deadline: BigInt(deadlineSec),
  }
}
