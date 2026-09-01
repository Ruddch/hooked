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

/** Defaults: HookedV1 listing 5 on Robinhood Chain. */
export const contracts = {
  hook: addr(import.meta.env.VITE_HOOK, '0x46C4455F65Da6d0E8Bb0274E257F99733ddE2544'),
  usdg: addr(import.meta.env.VITE_USDG, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  mainToken: addr(import.meta.env.VITE_MAIN_TOKEN, '0x66B99798eD319FE23a78B6399Baf03Ea521731E5'),
  swapRouter: addr(import.meta.env.VITE_SWAP_ROUTER, '0xf9636e6D09a59e5E2E0ffcda1fe2Ba15a2BcdaDC'),
  poolManager: addr(import.meta.env.VITE_POOL_MANAGER, '0x8366a39CC670B4001A1121B8F6A443A643e40951'),
  jackpot: addr(import.meta.env.VITE_JACKPOT, '0xA34259665e9D08FF18c1Cf38385dEDc18b3afa2F'),
  rewards: addr(import.meta.env.VITE_REWARDS, '0x2124f813732eef33F5dE208Ec6a3D76c2F04f41D'),
  poolFee: num(import.meta.env.VITE_POOL_FEE, 3000),
  tickSpacing: num(import.meta.env.VITE_TICK_SPACING, 60),
  listingId: BigInt(import.meta.env.VITE_LISTING_ID ?? '5'),
  poolId: hex32(
    import.meta.env.VITE_POOL_ID,
    '0xdd2bf4f6b6e46f7ae5ea88876d006ecf54e35f9a8e09d605b95a0478bf15df27',
  ),
} as const

/** Listing 5 deploy — loot logs cannot exist before this. */
export const winsFromBlock = BigInt(import.meta.env.VITE_WINS_FROM_BLOCK ?? '52127150')

export const tokenMeta = {
  usdgDecimals: 6,
  mainDecimals: 18,
  usdgSymbol: 'USDG',
  mainSymbol: '$HOOKED',
} as const

/** Public HTTP RPCs that answer from the browser (CORS) on chain 4663. */
const PUBLIC_RPC_URLS = [
  'https://rpc.mainnet.chain.robinhood.com',
  'https://rpc-robinhood.blockmachine.io',
  'https://robinhood-chain.gateway.tenderly.co',
]

function parseRpcUrls(raw: string | undefined) {
  if (!raw?.trim()) return []
  return raw.split(/[\s,]+/).map((url) => url.trim()).filter(Boolean)
}

function uniqueUrls(urls: string[]) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of urls) {
    const key = url.replace(/\/$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

function shuffleUrls(urls: string[]) {
  const out = [...urls]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Shuffled once per page load so visitors don't all stampede the same host. */
export const rpcUrls = shuffleUrls(uniqueUrls([...parseRpcUrls(import.meta.env.VITE_RPC_URL), ...PUBLIC_RPC_URLS]))

export const rpcUrl = rpcUrls[0] ?? PUBLIC_RPC_URLS[0]

export const explorerUrl = 'https://robinhoodchain.blockscout.com'
