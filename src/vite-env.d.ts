/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string
  readonly VITE_HOOK?: string
  readonly VITE_USDG?: string
  readonly VITE_MAIN_TOKEN?: string
  readonly VITE_SWAP_ROUTER?: string
  readonly VITE_POOL_MANAGER?: string
  readonly VITE_JACKPOT?: string
  readonly VITE_REWARDS?: string
  readonly VITE_POOL_FEE?: string
  readonly VITE_TICK_SPACING?: string
  readonly VITE_LISTING_ID?: string
  readonly VITE_POOL_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  __forceJackpot?: boolean
  __pendingJackpot?: boolean
  __pxStampDisk?: (cx: number, cy: number, rad: number, val: number) => void
  __hookedBurst?: (x: number, y: number, pow?: number) => void
  __bindSmiley?: (sv: SVGElement) => void
  __showJackReveal?: () => void
  __hideJackReveal?: () => void
  __setJackRevealTarget?: (n: number) => void
  __startLootDrop?: (amount: number) => void
  __closePlinko?: () => void
}
