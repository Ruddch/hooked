import { type Address, type Hex, isAddress, isHex } from 'viem'

function addr(value: string | undefined, fallback: Address): Address {
  return value && isAddress(value) ? value : fallback
}

function hex32(value: string | undefined, fallback: Hex): Hex {
  return value && isHex(value) && value.length === 66 ? value : fallback
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Defaults from contracts/VERIFICATION.md (Robinhood smoke listing). */
export const contracts = {
  hook: addr(import.meta.env.VITE_HOOK, '0x46C4455F65Da6d0E8Bb0274E257F99733ddE2544'),
  usdg: addr(import.meta.env.VITE_USDG, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  mainToken: addr(import.meta.env.VITE_MAIN_TOKEN, '0x900CB66B4B418BC6EA610e9b96319d933fFe0A12'),
  swapRouter: addr(import.meta.env.VITE_SWAP_ROUTER, '0xf9636e6D09a59e5E2E0ffcda1fe2Ba15a2BcdaDC'),
  poolManager: addr(import.meta.env.VITE_POOL_MANAGER, '0x8366a39CC670B4001A1121B8F6A443A643e40951'),
  jackpot: addr(import.meta.env.VITE_JACKPOT, '0x9E4a4a464e4dEbE59b3382BD58dAF88F022501b4'),
  rewards: addr(import.meta.env.VITE_REWARDS, '0x851Dcca04E50937Edd21E4093E968F42b2784Ed9'),
  poolFee: num(import.meta.env.VITE_POOL_FEE, 3000),
  tickSpacing: num(import.meta.env.VITE_TICK_SPACING, 60),
  listingId: BigInt(import.meta.env.VITE_LISTING_ID ?? '1'),
  poolId: hex32(
    import.meta.env.VITE_POOL_ID,
    '0x12d060f5e55b84e5882955278c090ad43ac43b48148401bbb8959d671f40ba75',
  ),
} as const

export const tokenMeta = {
  usdgDecimals: 6,
  mainDecimals: 18,
  usdgSymbol: 'USDG',
  mainSymbol: '$HOOKED',
} as const

export const rpcUrl =
  import.meta.env.VITE_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'

export const explorerUrl = 'https://robinhoodchain.blockscout.com'
