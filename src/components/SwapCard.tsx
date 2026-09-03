import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  formatUnits,
  maxUint256,
  parseUnits,
  type TransactionReceipt,
  UserRejectedRequestError,
} from 'viem'
import {
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from 'wagmi'
import { erc20Abi } from '../abi/erc20'
import { hookedV1Abi, jackpotPoolAbi, poolSwapTestAbi, rewardsCollectorAbi } from '../abi/hooked'
import { robinhood } from '../chain'
import { contracts, tokenMeta } from '../config'
import { closeLootDrop, setLootWaitingPhase, startLootDrop, startLootWaiting } from '../fx/homeFx'
import { applySlippage, encodeEthBuyRoute, ethGasReserve, quoteEthToUsdg, universalRouterAbi } from '../lib/ethUsdg'
import {
  fetchDrandSignature,
  LootTimeoutError,
  MIN_BUY_USDG_FALLBACK,
  parseBuyTicketFromReceipt,
  recoverBuyTicket,
  toLootDrop,
  waitForLootSettle,
} from '../lib/lootSettle'
import { poolManagerAbi, poolStateSlot, quoteExactIn, quoteExactOut, sqrtPriceX96FromSlot0 } from '../lib/poolQuote'
import { useWalletUi } from './ConnectWallet'
import { TokenCa } from './TokenCa'

const MIN_SQRT_PRICE = 4295128739n
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n

type PayAsset = 'eth' | 'usdg'
type PendingKind = 'approve' | 'swap' | null

function fmtRange(n: number) {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return n.toLocaleString('en-US', { maximumSignificantDigits: 4 })
}

function parseLoose(value: string, decimals: number): bigint | null {
  const cleaned = value.trim().replace(',', '.')
  if (!cleaned || Number(cleaned) <= 0) return null
  try {
    return parseUnits(cleaned, decimals)
  } catch {
    return null
  }
}

function trimUnits(value: string) {
  if (!value.includes('.')) return value
  return value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

function formatInputAmount(value: bigint, decimals: number, maxFrac: number) {
  const [whole, frac = ''] = formatUnits(value, decimals).split('.')
  if (!frac) return whole
  const cut = frac.slice(0, maxFrac).replace(/0+$/, '')
  return cut ? `${whole}.${cut}` : whole
}

export function SwapCard() {
  const { address, isConnected, chainId } = useAccount()
  const { setOpen } = useWalletUi()
  const { switchChain, isPending: switching } = useSwitchChain()
  const publicClient = usePublicClient({ chainId: robinhood.id })
  const queryClient = useQueryClient()
  const { writeContractAsync, isPending: writing, error: writeError } = useWriteContract()
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [payAsset, setPayAsset] = useState<PayAsset>('usdg')
  const [usdgAmount, setUsdgAmount] = useState('')
  const [ethAmount, setEthAmount] = useState('')
  const [hookedAmount, setHookedAmount] = useState('')
  const [lastEdited, setLastEdited] = useState<'pay' | 'hooked'>('pay')
  const [busyLoot, setBusyLoot] = useState(false)
  const [settling, setSettling] = useState(false)
  const [pendingKind, setPendingKind] = useState<PendingKind>(null)
  const [approveMode, setApproveMode] = useState<'exact' | 'max' | null>(null)
  const [localErr, setLocalErr] = useState<string | null>(null)
  const [amountFocused, setAmountFocused] = useState(false)
  const [ethUsdgOut, setEthUsdgOut] = useState<bigint | null>(null)
  const [ethUsdgFee, setEthUsdgFee] = useState<number | null>(null)
  const [ethQuoteBusy, setEthQuoteBusy] = useState(false)

  const payingEth = side === 'buy' && payAsset === 'eth'
  const erc20PayToken = side === 'buy' ? contracts.usdg : contracts.mainToken
  const payDecimals = payingEth
    ? tokenMeta.ethDecimals
    : side === 'buy'
      ? tokenMeta.usdgDecimals
      : tokenMeta.mainDecimals
  const usdgParsed = parseLoose(usdgAmount, tokenMeta.usdgDecimals)
  const ethParsed = parseLoose(ethAmount, tokenMeta.ethDecimals)
  const hookedParsed = parseLoose(hookedAmount, tokenMeta.mainDecimals)
  const onRightChain = chainId === robinhood.id

  const fee = useReadContract({
    address: contracts.hook,
    abi: hookedV1Abi,
    functionName: 'poolFee',
    query: { retry: false },
  })
  const spacing = useReadContract({
    address: contracts.hook,
    abi: hookedV1Abi,
    functionName: 'tickSpacing',
    query: { retry: false },
  })
  const minBuy = useReadContract({
    address: contracts.rewards,
    abi: rewardsCollectorAbi,
    functionName: 'minBuyUsdg',
    query: { retry: false, staleTime: 60_000 },
  })
  const minBuyUsdg = minBuy.data ?? MIN_BUY_USDG_FALLBACK

  const tokenBalance = useReadContract({
    address: erc20PayToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(address) && !payingEth,
      refetchInterval: amountFocused ? 10_000 : false,
      refetchOnWindowFocus: false,
    },
  })

  const ethBalance = useBalance({
    address,
    chainId: robinhood.id,
    query: {
      enabled: Boolean(address) && payingEth,
      refetchInterval: amountFocused ? 10_000 : false,
      refetchOnWindowFocus: false,
    },
  })

  const balanceData = payingEth ? ethBalance.data?.value : tokenBalance.data

  const allowance = useReadContract({
    address: contracts.usdg,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, contracts.swapRouter] : undefined,
    query: {
      enabled: Boolean(address) && side === 'buy',
      refetchOnWindowFocus: false,
    },
  })

  const sellAllowance = useReadContract({
    address: contracts.mainToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, contracts.swapRouter] : undefined,
    query: {
      enabled: Boolean(address) && side === 'sell',
      refetchOnWindowFocus: false,
    },
  })

  const activeAllowance = side === 'buy' ? allowance : sellAllowance

  const slot0 = useReadContract({
    address: contracts.poolManager,
    abi: poolManagerAbi,
    functionName: 'extsload',
    args: [poolStateSlot(contracts.poolId)],
    query: {
      enabled: amountFocused || payingEth,
      retry: false,
      refetchInterval: amountFocused || payingEth ? 10_000 : false,
      refetchOnWindowFocus: false,
    },
  })

  const poolFee = fee.data ?? contracts.poolFee
  const tickSpacing = spacing.data ?? contracts.tickSpacing
  const sqrtP = slot0.data ? sqrtPriceX96FromSlot0(slot0.data) : null

  useEffect(() => {
    if (!payingEth || !publicClient || ethParsed == null) {
      setEthUsdgOut(null)
      setEthUsdgFee(null)
      setEthQuoteBusy(false)
      return
    }
    let cancelled = false
    setEthQuoteBusy(true)
    const t = window.setTimeout(() => {
      void quoteEthToUsdg(publicClient, ethParsed)
        .then((q) => {
          if (cancelled) return
          setEthUsdgOut(q?.amountOut ?? null)
          setEthUsdgFee(q?.fee ?? null)
        })
        .catch(() => {
          if (cancelled) return
          setEthUsdgOut(null)
          setEthUsdgFee(null)
        })
        .finally(() => {
          if (!cancelled) setEthQuoteBusy(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [payingEth, publicClient, ethParsed])

  const derivedUsdgIn = useMemo(() => {
    if (side !== 'buy' || payingEth || lastEdited !== 'hooked' || hookedParsed == null || sqrtP == null) return null
    const { amountIn } = quoteExactOut(hookedParsed, sqrtP, true)
    return amountIn > 0n ? amountIn : null
  }, [side, payingEth, lastEdited, hookedParsed, sqrtP])

  const buyParsed =
    side === 'buy' ? (payingEth ? ethUsdgOut : lastEdited === 'pay' ? usdgParsed : derivedUsdgIn) : null
  const sellParsed = side === 'sell' ? hookedParsed : null
  const swapParsed = side === 'buy' ? buyParsed : sellParsed

  const amount =
    side === 'buy'
      ? payingEth
        ? ethAmount
        : lastEdited === 'pay'
          ? usdgAmount
          : derivedUsdgIn != null
            ? formatInputAmount(derivedUsdgIn, tokenMeta.usdgDecimals, 6)
            : ''
      : hookedAmount

  const humanIn = Number(amount) || 0

  const needsSellApprove = side === 'sell' && sellParsed != null && (sellAllowance.data ?? 0n) < sellParsed
  const needsBuyApprove =
    side === 'buy' && !payingEth && buyParsed != null && (allowance.data ?? 0n) < buyParsed

  const lowBalance = Boolean(
    isConnected &&
      (payingEth
        ? ethParsed != null && balanceData != null && ethParsed > balanceData
        : swapParsed != null && balanceData != null && swapParsed > balanceData),
  )

  const outDecimals = side === 'buy' ? tokenMeta.mainDecimals : tokenMeta.usdgDecimals

  const quote = useMemo(() => {
    if (swapParsed == null || sqrtP == null) return null
    const { net } = quoteExactIn(swapParsed, sqrtP, side === 'buy')
    if (net <= 0n) return null
    const base = Number(formatUnits(net, outDecimals))
    if (!Number.isFinite(base) || base <= 0) return null
    return base
  }, [swapParsed, sqrtP, side, outDecimals])

  const outLow = quote != null && side === 'buy' ? fmtRange(quote * 0.9) : '—'
  const outHigh = quote != null && side === 'buy' ? fmtRange(quote * 4) : '—'
  const sellOut = quote != null && side === 'sell' ? fmtRange(quote) : '—'

  const setMode = (next: 'buy' | 'sell') => {
    setSide(next)
    setLocalErr(null)
    if (next === 'sell') setPayAsset('usdg')
  }

  const setPay = (next: PayAsset) => {
    setPayAsset(next)
    setLocalErr(null)
    setLastEdited('pay')
    setAmountFocused(true)
  }

  const canFillPay = Boolean(isConnected && balanceData != null && balanceData > 0n)

  const fillPay = (bps: bigint) => {
    if (balanceData == null || balanceData <= 0n) return
    if (payingEth) {
      const spendable = ethGasReserve(balanceData)
      const raw = bps >= 10_000n ? spendable : (spendable * bps) / 10_000n
      if (raw <= 0n) return
      setEthAmount(trimUnits(formatUnits(raw, tokenMeta.ethDecimals)))
      setLastEdited('pay')
    } else if (side === 'sell') {
      const raw = bps >= 10_000n ? balanceData : (balanceData * bps) / 10_000n
      if (raw <= 0n) return
      setHookedAmount(trimUnits(formatUnits(raw, tokenMeta.mainDecimals)))
      setLastEdited('hooked')
    } else {
      const raw = bps >= 10_000n ? balanceData : (balanceData * bps) / 10_000n
      if (raw <= 0n) return
      setUsdgAmount(trimUnits(formatUnits(raw, tokenMeta.usdgDecimals)))
      setLastEdited('pay')
    }
    setLocalErr(null)
    setAmountFocused(true)
    requestAnimationFrame(() => document.getElementById('amount')?.focus())
  }

  const balLabel = useMemo(() => {
    if (balanceData == null) return null
    const n = Number(formatUnits(balanceData, payDecimals))
    return n.toLocaleString('en-US', {
      maximumFractionDigits: payDecimals === 6 ? 2 : payingEth ? 5 : 4,
    })
  }, [balanceData, payDecimals, payingEth])

  useEffect(() => {
    const onClosed = () => {
      setBusyLoot(false)
      setSettling(false)
    }
    window.addEventListener('hooked:plinko-closed', onClosed)
    return () => window.removeEventListener('hooked:plinko-closed', onClosed)
  }, [])

  const err = localErr || (writeError ? writeError.message : null)

  const label = (() => {
    if (!isConnected) return 'Connect wallet'
    if (!onRightChain) return switching ? 'Switching…' : 'Switch to Robinhood'
    if (pendingKind === 'approve') return writing ? 'Approve in wallet…' : 'Approving…'
    if (pendingKind === 'swap') return writing ? 'Confirm swap…' : 'Swapping…'
    if (settling) return 'Settling…'
    if (busyLoot) return 'Dropping…'
    if (payingEth && ethQuoteBusy && ethParsed != null) return 'Quoting…'
    if (payingEth && ethParsed != null && ethUsdgOut == null && !ethQuoteBusy) return 'No ETH→USDG route'
    if (lowBalance && onRightChain) return 'Not enough balance'
    if (!(humanIn > 0)) return side === 'buy' ? 'Swap & drop' : 'Sell'
    return side === 'buy' ? 'Swap & drop' : 'Sell'
  })()

  const showApprove = Boolean(
    isConnected &&
      onRightChain &&
      (needsSellApprove || needsBuyApprove) &&
      swapParsed != null &&
      humanIn > 0 &&
      !lowBalance &&
      !busyLoot &&
      !settling,
  )

  const disabled =
    writing ||
    pendingKind != null ||
    busyLoot ||
    switching ||
    (lowBalance && onRightChain) ||
    (payingEth && ethQuoteBusy) ||
    (payingEth && ethParsed != null && ethUsdgOut == null)

  const refreshPayBalance = useCallback(
    async (blockNumber?: bigint) => {
      if (!address || !publicClient) {
        if (payingEth) await ethBalance.refetch()
        else await tokenBalance.refetch()
        return
      }
      const waits = [0, 300, 800, 1500]
      for (const wait of waits) {
        if (wait) await new Promise((r) => setTimeout(r, wait))
        try {
          if (payingEth) {
            const next = await publicClient.getBalance({
              address,
              ...(blockNumber != null ? { blockNumber } : {}),
            })
            queryClient.setQueryData(ethBalance.queryKey, (prev: typeof ethBalance.data) =>
              prev ? { ...prev, value: next } : { value: next, decimals: 18, symbol: 'ETH', formatted: formatUnits(next, 18) },
            )
            return
          }
          const next = await publicClient.readContract({
            address: erc20PayToken,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address],
            ...(blockNumber != null ? { blockNumber } : {}),
          })
          queryClient.setQueryData(tokenBalance.queryKey, next)
          return
        } catch {
          /* receipt node may not have the block yet */
        }
      }
      if (payingEth) await ethBalance.refetch()
      else await tokenBalance.refetch()
    },
    [address, erc20PayToken, ethBalance, payingEth, publicClient, queryClient, tokenBalance],
  )

  const runLoot = useCallback(
    async (swapped: TransactionReceipt, amountInUsdg: bigint) => {
      if (!address || !publicClient || swapped.blockNumber == null) return
      const likelyOpen = amountInUsdg >= minBuyUsdg
      if (likelyOpen) {
        setBusyLoot(true)
        setSettling(true)
        startLootWaiting()
      }
      let ticket = parseBuyTicketFromReceipt(swapped, minBuyUsdg)
      if (ticket.kind === 'none' || (ticket.kind === 'open' && ticket.targetDrandRound === 0n)) {
        ticket = await recoverBuyTicket(publicClient, swapped, address, minBuyUsdg)
      }
      if (ticket.kind === 'skipped') {
        closeLootDrop()
        setBusyLoot(false)
        setSettling(false)
        const floor = ticket.minBuyUsdg ?? minBuyUsdg
        setLocalErr(
          `Buy under ${trimUnits(formatUnits(floor, tokenMeta.usdgDecimals))} USDG skips the loot roll. Fee still goes to the pool.`,
        )
        return
      }
      if (ticket.kind !== 'open') {
        closeLootDrop()
        setBusyLoot(false)
        setSettling(false)
        setLocalErr('Swap landed, but no loot ticket opened')
        return
      }

      setBusyLoot(true)
      setSettling(true)
      const waitRound = ticket.targetDrandRound > 0n ? Number(ticket.targetDrandRound) : undefined
      startLootWaiting({ targetRound: waitRound })
      const ac = new AbortController()
      const onClosed = () => ac.abort()
      window.addEventListener('hooked:plinko-closed', onClosed)
      try {
        const settle = await waitForLootSettle({
          client: publicClient,
          buyer: address,
          buyId: ticket.buyId,
          fromBlock: swapped.blockNumber,
          targetDrandRound: ticket.targetDrandRound,
          signal: ac.signal,
          onPhase: (phase) => {
            setLootWaitingPhase({
              targetRound: phase.targetRound > 0n ? Number(phase.targetRound) : waitRound,
              ready: phase.ready,
              confirming: phase.confirming,
            })
          },
          submitSettle: async ({ buyId, round }) => {
            const signature = await fetchDrandSignature(round)
            try {
              const hash = await writeContractAsync({
                address: contracts.jackpot,
                abi: jackpotPoolAbi,
                functionName: 'settleWithDrand',
                args: [buyId, round, signature],
              })
              return await publicClient.waitForTransactionReceipt({ hash })
            } catch (e) {
              const rejected =
                e instanceof UserRejectedRequestError ||
                (e instanceof Error && /user rejected|denied|rejected the request/i.test(e.message))
              if (rejected) return null
              throw e
            }
          },
        })
        if (ac.signal.aborted) {
          setBusyLoot(false)
          setSettling(false)
          return
        }
        setSettling(false)
        startLootDrop(toLootDrop(ticket, settle))
        window.dispatchEvent(new CustomEvent('hooked:loot-settled'))
        void refreshPayBalance()
      } catch (lootErr) {
        if (ac.signal.aborted || (lootErr instanceof DOMException && lootErr.name === 'AbortError')) {
          setBusyLoot(false)
          setSettling(false)
          return
        }
        closeLootDrop()
        setBusyLoot(false)
        setSettling(false)
        setLocalErr(
          lootErr instanceof LootTimeoutError
            ? 'Loot still settling — check Recent wins in a bit'
            : lootErr instanceof Error
              ? lootErr.message
              : 'Loot settle failed',
        )
      } finally {
        window.removeEventListener('hooked:plinko-closed', onClosed)
      }
    },
    [address, minBuyUsdg, publicClient, refreshPayBalance, writeContractAsync],
  )

  const swapHooked = useCallback(
    async (amountIn: bigint, zeroForOne: boolean) => {
      if (!publicClient) throw new Error('RPC unavailable')
      setPendingKind('swap')
      const swapHash = await writeContractAsync({
        address: contracts.swapRouter,
        abi: poolSwapTestAbi,
        functionName: 'swap',
        args: [
          {
            currency0: contracts.usdg,
            currency1: contracts.mainToken,
            fee: poolFee,
            tickSpacing,
            hooks: contracts.hook,
          },
          {
            zeroForOne,
            amountSpecified: -amountIn,
            sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
          },
          { takeClaims: false, settleUsingBurn: false },
          '0x',
        ],
      })
      const swapped = await publicClient.waitForTransactionReceipt({ hash: swapHash })
      setPendingKind(null)
      return swapped
    },
    [poolFee, publicClient, tickSpacing, writeContractAsync],
  )

  const submit = useCallback(async () => {
    setLocalErr(null)
    if (!isConnected) {
      setOpen(true)
      return
    }
    if (!onRightChain) {
      switchChain({ chainId: robinhood.id })
      return
    }
    if (!publicClient || !address) {
      setLocalErr('RPC unavailable')
      return
    }

    try {
      if (side === 'sell') {
        if (sellParsed == null) {
          document.getElementById('amount')?.focus()
          return
        }
        if (balanceData != null && sellParsed > balanceData) {
          setLocalErr('Not enough balance')
          return
        }
        const swapped = await swapHooked(sellParsed, false)
        if (swapped.status === 'reverted') {
          setLocalErr('Transaction failed')
          void refreshPayBalance(swapped.blockNumber ?? undefined)
          return
        }
        setUsdgAmount('')
        setHookedAmount('')
        void refreshPayBalance(swapped.blockNumber ?? undefined)
        void sellAllowance.refetch()
        return
      }

      if (payingEth) {
        if (ethParsed == null || ethUsdgOut == null || ethUsdgFee == null) {
          document.getElementById('amount')?.focus()
          return
        }
        if (balanceData != null && ethParsed > balanceData) {
          setLocalErr('Not enough balance')
          return
        }

        const minUsdgOut = applySlippage(ethUsdgOut, contracts.ethUsdgSlippageBps)
        const hookedQuote =
          sqrtP != null ? quoteExactIn(ethUsdgOut, sqrtP, true).net : 0n
        const minHookedOut =
          hookedQuote > 0n ? applySlippage(hookedQuote, contracts.hookedSlippageBps) : 0n

        const route = encodeEthBuyRoute({
          ethIn: ethParsed,
          v3Fee: ethUsdgFee,
          minUsdgOut,
          minHookedOut,
          poolFee,
          tickSpacing,
        })

        setPendingKind('swap')
        const swapHash = await writeContractAsync({
          address: contracts.universalRouter,
          abi: universalRouterAbi,
          functionName: 'execute',
          args: [route.commands, route.inputs, route.deadline],
          value: route.value,
        })
        const swapped = await publicClient.waitForTransactionReceipt({ hash: swapHash })
        setPendingKind(null)
        if (swapped.status === 'reverted') {
          setLocalErr('Transaction failed')
          void refreshPayBalance(swapped.blockNumber ?? undefined)
          return
        }
        setEthAmount('')
        setUsdgAmount('')
        setHookedAmount('')
        void refreshPayBalance(swapped.blockNumber ?? undefined)
        await runLoot(swapped, ethUsdgOut)
        return
      }

      if (buyParsed == null) {
        document.getElementById('amount')?.focus()
        return
      }
      if (balanceData != null && buyParsed > balanceData) {
        setLocalErr('Not enough balance')
        return
      }
      const swapped = await swapHooked(buyParsed, true)
      if (swapped.status === 'reverted') {
        setLocalErr('Transaction failed')
        void refreshPayBalance(swapped.blockNumber ?? undefined)
        return
      }
      setUsdgAmount('')
      setHookedAmount('')
      void refreshPayBalance(swapped.blockNumber ?? undefined)
      void allowance.refetch()
      await runLoot(swapped, buyParsed)
    } catch (e) {
      setPendingKind(null)
      const rejected =
        e instanceof UserRejectedRequestError ||
        (e instanceof Error && /user rejected|denied|rejected the request/i.test(e.message))
      if (!rejected && e instanceof Error) setLocalErr(e.message)
    }
  }, [
    isConnected,
    address,
    onRightChain,
    side,
    payingEth,
    ethParsed,
    ethUsdgOut,
    ethUsdgFee,
    buyParsed,
    sellParsed,
    balanceData,
    publicClient,
    setOpen,
    switchChain,
    writeContractAsync,
    refreshPayBalance,
    allowance,
    sellAllowance,
    swapHooked,
    runLoot,
    sqrtP,
    poolFee,
    tickSpacing,
  ])

  const approveSpend = useCallback(
    async (value: bigint, mode: 'exact' | 'max') => {
      setLocalErr(null)
      if (!publicClient) {
        setLocalErr('RPC unavailable')
        return
      }
      const token = side === 'buy' ? contracts.usdg : contracts.mainToken
      try {
        setApproveMode(mode)
        setPendingKind('approve')
        const approveHash = await writeContractAsync({
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [contracts.swapRouter, value],
        })
        const approved = await publicClient.waitForTransactionReceipt({ hash: approveHash })
        setPendingKind(null)
        setApproveMode(null)
        void activeAllowance.refetch()
        if (approved.status === 'reverted') setLocalErr('Approve failed')
      } catch (e) {
        setPendingKind(null)
        setApproveMode(null)
        const rejected =
          e instanceof UserRejectedRequestError ||
          (e instanceof Error && /user rejected|denied|rejected the request/i.test(e.message))
        if (!rejected && e instanceof Error) setLocalErr(e.message)
      }
    },
    [activeAllowance, publicClient, side, writeContractAsync],
  )

  const payName = side === 'buy' ? (payingEth ? 'ETH' : 'USDG') : '$HOOKED'
  const getName = side === 'buy' ? '$HOOKED' : 'USDG'
  const payDot = side === 'buy' ? (payingEth ? 'eth' : 'usdg') : 'hk'
  const getDot = side === 'buy' ? 'hk' : 'usdg'
  const showPcts = side === 'sell' || (side === 'buy' && isConnected)

  const usdgHint =
    payingEth && ethUsdgOut != null
      ? `≈ ${trimUnits(formatUnits(ethUsdgOut, tokenMeta.usdgDecimals))} USDG`
      : null

  return (
    <div className="swap" id="swap">
      <TokenCa />
      <div className="swap-tabs" role="tablist" aria-label="Buy or sell">
        <button type="button" role="tab" aria-selected={side === 'buy'} className={side === 'buy' ? 'on' : ''} onClick={() => setMode('buy')}>
          Buy
        </button>
        <button type="button" role="tab" aria-selected={side === 'sell'} className={side === 'sell' ? 'on' : ''} onClick={() => setMode('sell')}>
          Sell
        </button>
      </div>
      <div className="row">
        <div className="lab">
          <span className="mono">You pay</span>
          {side === 'buy' ? (
            <div className="pay-asset" role="group" aria-label="Pay with">
              <button type="button" className={payAsset === 'eth' ? 'on' : ''} onClick={() => setPay('eth')}>
                <i className="dot eth" aria-hidden="true" /> ETH
              </button>
              <button type="button" className={payAsset === 'usdg' ? 'on' : ''} onClick={() => setPay('usdg')}>
                <i className="dot usdg" aria-hidden="true" /> USDG
              </button>
            </div>
          ) : (
            <span className="tok">
              <i className={`dot ${payDot}`} aria-hidden="true" /> {payName}
            </span>
          )}
        </div>
        <input
          id="amount"
          type="text"
          inputMode="decimal"
          placeholder="enter amount"
          autoComplete="off"
          className={lowBalance ? 'low' : undefined}
          aria-invalid={lowBalance || undefined}
          value={amount}
          onFocus={() => setAmountFocused(true)}
          onBlur={() => setAmountFocused(false)}
          onChange={(e) => {
            const next = e.target.value
            if (side === 'buy') {
              if (payingEth) setEthAmount(next)
              else setUsdgAmount(next)
              setLastEdited('pay')
            } else {
              setHookedAmount(next)
              setLastEdited('hooked')
            }
          }}
        />
        {showPcts || (balLabel != null && isConnected) ? (
          <div className="pay-meta">
            {balLabel != null && isConnected ? (
              <span className={lowBalance ? 'bal low' : 'bal'}>
                bal {balLabel}
                {usdgHint ? <span className="bal-hint"> · {usdgHint}</span> : null}
              </span>
            ) : (
              <span className="bal" />
            )}
            {showPcts ? (
              <div className="pcts">
                <button type="button" disabled={!canFillPay} onMouseDown={(e) => e.preventDefault()} onClick={() => fillPay(2_500n)}>
                  25%
                </button>
                <button type="button" disabled={!canFillPay} onMouseDown={(e) => e.preventDefault()} onClick={() => fillPay(5_000n)}>
                  50%
                </button>
                <button type="button" disabled={!canFillPay} onMouseDown={(e) => e.preventDefault()} onClick={() => fillPay(10_000n)}>
                  max
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flip">
        <button type="button" onClick={() => setMode(side === 'buy' ? 'sell' : 'buy')} aria-label="Flip buy and sell">
          ↕
        </button>
      </div>
      <div className="row">
        <div className="lab">
          <span className="mono">{side === 'buy' ? 'You might get' : 'You get'}</span>
          <span className="tok">
            <i className={`dot ${getDot}`} aria-hidden="true" /> {getName}
          </span>
        </div>
        <p className="range" id="estimate">
          {side === 'buy' ? (
            <>
              <b>{outLow}</b> – <b>{outHigh}</b>
            </>
          ) : (
            <b>{sellOut}</b>
          )}
        </p>
      </div>
      {side === 'buy' ? (
        <p className="jack-tease">
          <i className="spark" aria-hidden="true" />
          <span>
            every swap can hit the <b>jackpot</b>
            {payingEth ? <span className="via-eth"> · via USDG</span> : null}
          </span>
        </p>
      ) : (
        <p className="sell-note">Sells skip the loot roll. Fee goes to jackpot and ops.</p>
      )}
      {showApprove ? (
        <div className="go-row">
          <button
            className="go"
            id="swapBtn"
            type="button"
            disabled={disabled}
            onClick={() => {
              if (swapParsed != null) void approveSpend(swapParsed, 'exact')
            }}
          >
            <span className="pxfx" aria-hidden="true" />
            <span className="lbl">
              {pendingKind === 'approve' && approveMode === 'exact'
                ? writing
                  ? 'Approve in wallet…'
                  : 'Approving…'
                : `Approve ${payName}`}
            </span>
          </button>
          <button className="go" type="button" disabled={disabled} onClick={() => void approveSpend(maxUint256, 'max')}>
            <span className="lbl">
              {pendingKind === 'approve' && approveMode === 'max'
                ? writing
                  ? 'Approve in wallet…'
                  : 'Approving…'
                : 'Infinite approve'}
            </span>
          </button>
        </div>
      ) : (
        <button className="go" id="swapBtn" type="button" disabled={disabled} onClick={() => void submit()}>
          <span className="pxfx" aria-hidden="true" />
          <span className="lbl">{label}</span>
        </button>
      )}
      {err ? <p className="err">{err}</p> : null}
      {side === 'buy' ? (
        <a className="hint" href="#loot">
          Loot is the swap.
        </a>
      ) : null}
    </div>
  )
}
