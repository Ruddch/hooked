import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits, maxUint256, parseUnits, UserRejectedRequestError } from 'viem'
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from 'wagmi'
import { erc20Abi } from '../abi/erc20'
import { hookedV1Abi, jackpotPoolAbi, poolSwapTestAbi } from '../abi/hooked'
import { robinhood } from '../chain'
import { contracts, tokenMeta } from '../config'
import { closeLootDrop, setLootWaitingPhase, startLootDrop, startLootWaiting } from '../fx/homeFx'
import {
  fetchDrandSignature,
  LootTimeoutError,
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
  const [usdgAmount, setUsdgAmount] = useState('')
  const [hookedAmount, setHookedAmount] = useState('')
  const [lastEdited, setLastEdited] = useState<'usdg' | 'hooked'>('usdg')
  const [busyLoot, setBusyLoot] = useState(false)
  const [settling, setSettling] = useState(false)
  const [pendingKind, setPendingKind] = useState<'approve' | 'swap' | null>(null)
  const [approveMode, setApproveMode] = useState<'exact' | 'max' | null>(null)
  const [localErr, setLocalErr] = useState<string | null>(null)
  const [amountFocused, setAmountFocused] = useState(false)

  const payToken = side === 'buy' ? contracts.usdg : contracts.mainToken
  const payDecimals = side === 'buy' ? tokenMeta.usdgDecimals : tokenMeta.mainDecimals
  const usdgParsed = parseLoose(usdgAmount, tokenMeta.usdgDecimals)
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

  const balance = useReadContract({
    address: payToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(address),
      refetchInterval: amountFocused ? 10_000 : false,
      refetchOnWindowFocus: false,
    },
  })

  const allowance = useReadContract({
    address: payToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, contracts.swapRouter] : undefined,
    query: {
      enabled: Boolean(address),
      refetchOnWindowFocus: false,
    },
  })

  const slot0 = useReadContract({
    address: contracts.poolManager,
    abi: poolManagerAbi,
    functionName: 'extsload',
    args: [poolStateSlot(contracts.poolId)],
    query: {
      enabled: amountFocused,
      retry: false,
      refetchInterval: amountFocused ? 10_000 : false,
      refetchOnWindowFocus: false,
    },
  })

  const poolFee = fee.data ?? contracts.poolFee
  const tickSpacing = spacing.data ?? contracts.tickSpacing
  const sqrtP = slot0.data ? sqrtPriceX96FromSlot0(slot0.data) : null

  const derivedHookedIn = useMemo(() => {
    if (lastEdited !== 'usdg' || usdgParsed == null || sqrtP == null) return null
    const { amountIn } = quoteExactOut(usdgParsed, sqrtP, false)
    return amountIn > 0n ? amountIn : null
  }, [lastEdited, usdgParsed, sqrtP])

  const derivedUsdgIn = useMemo(() => {
    if (lastEdited !== 'hooked' || hookedParsed == null || sqrtP == null) return null
    const { amountIn } = quoteExactOut(hookedParsed, sqrtP, true)
    return amountIn > 0n ? amountIn : null
  }, [lastEdited, hookedParsed, sqrtP])

  const parsed =
    side === 'buy'
      ? lastEdited === 'usdg'
        ? usdgParsed
        : derivedUsdgIn
      : lastEdited === 'hooked'
        ? hookedParsed
        : derivedHookedIn

  const amount =
    side === 'buy'
      ? lastEdited === 'usdg'
        ? usdgAmount
        : derivedUsdgIn != null
          ? formatInputAmount(derivedUsdgIn, tokenMeta.usdgDecimals, 6)
          : ''
      : lastEdited === 'hooked'
        ? hookedAmount
        : derivedHookedIn != null
          ? formatInputAmount(derivedHookedIn, tokenMeta.mainDecimals, 6)
          : ''

  const needsApprove = parsed != null && (allowance.data ?? 0n) < parsed
  const lowBalance = Boolean(isConnected && parsed != null && balance.data != null && parsed > balance.data)
  const humanIn = Number(amount) || 0
  const outDecimals = side === 'buy' ? tokenMeta.mainDecimals : tokenMeta.usdgDecimals

  const quote = useMemo(() => {
    if (parsed == null || sqrtP == null) return null
    const { net } = quoteExactIn(parsed, sqrtP, side === 'buy')
    if (net <= 0n) return null
    const base = Number(formatUnits(net, outDecimals))
    if (!Number.isFinite(base) || base <= 0) return null
    return base
  }, [parsed, sqrtP, side, outDecimals])

  const outLow = quote != null && side === 'buy' ? fmtRange(quote * 0.9) : '—'
  const outHigh = quote != null && side === 'buy' ? fmtRange(quote * 4) : '—'
  const sellOut =
    lastEdited === 'usdg' && usdgParsed != null
      ? fmtRange(Number(formatUnits(usdgParsed, tokenMeta.usdgDecimals)))
      : quote != null && side === 'sell'
        ? fmtRange(quote)
        : '—'

  const setMode = (next: 'buy' | 'sell') => {
    setSide(next)
    setLocalErr(null)
  }

  const canFillSell = Boolean(isConnected && balance.data != null && balance.data > 0n)

  const fillSell = (bps: bigint) => {
    if (balance.data == null || balance.data <= 0n) return
    const raw = bps >= 10_000n ? balance.data : (balance.data * bps) / 10_000n
    if (raw <= 0n) return
    setHookedAmount(trimUnits(formatUnits(raw, tokenMeta.mainDecimals)))
    setLastEdited('hooked')
    setLocalErr(null)
    setAmountFocused(true)
    requestAnimationFrame(() => document.getElementById('amount')?.focus())
  }

  const balLabel = useMemo(() => {
    if (balance.data == null) return null
    const n = Number(formatUnits(balance.data, payDecimals))
    return n.toLocaleString('en-US', { maximumFractionDigits: payDecimals === 6 ? 2 : 4 })
  }, [balance.data, payDecimals])

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
    if (lowBalance && onRightChain) return 'Not enough balance'
    if (!(humanIn > 0)) return side === 'buy' ? 'Swap & drop' : 'Sell'
    return side === 'buy' ? 'Swap & drop' : 'Sell'
  })()

  const showApprove = Boolean(
    isConnected && onRightChain && needsApprove && parsed != null && humanIn > 0 && !lowBalance && !busyLoot && !settling,
  )

  const disabled = writing || pendingKind != null || busyLoot || switching || (lowBalance && onRightChain)

  const applyPayBalance = useCallback(
    (next: bigint) => {
      queryClient.setQueryData(balance.queryKey, next)
    },
    [balance.queryKey, queryClient],
  )

  const refreshPayBalance = useCallback(
    async (blockNumber?: bigint) => {
      if (!address || !publicClient) {
        await balance.refetch()
        return
      }
      const waits = [0, 300, 800, 1500]
      for (const wait of waits) {
        if (wait) await new Promise((r) => setTimeout(r, wait))
        try {
          const next = await publicClient.readContract({
            address: payToken,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address],
            ...(blockNumber != null ? { blockNumber } : {}),
          })
          applyPayBalance(next)
          return
        } catch {
          /* receipt node may not have the block yet */
        }
      }
      await balance.refetch()
    },
    [address, applyPayBalance, balance, payToken, publicClient],
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
    if (parsed == null) {
      document.getElementById('amount')?.focus()
      return
    }
    if (balance.data != null && parsed > balance.data) {
      setLocalErr('Not enough balance')
      return
    }
    if (!publicClient) {
      setLocalErr('RPC unavailable')
      return
    }

    const amountIn = parsed
    const zeroForOne = side === 'buy'

    try {
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
      if (swapped.status === 'reverted') {
        setLocalErr('Transaction failed')
        void refreshPayBalance(swapped.blockNumber ?? undefined)
        return
      }
      const left = (balance.data ?? 0n) > amountIn ? (balance.data ?? 0n) - amountIn : 0n
      applyPayBalance(left)
      setUsdgAmount('')
      setHookedAmount('')
      void refreshPayBalance(swapped.blockNumber ?? undefined)
      void allowance.refetch()
      if (zeroForOne) {
        if (!address || swapped.blockNumber == null) return
        const likelyOpen = parsed != null && parsed >= 1_000_000n
        if (likelyOpen) {
          setBusyLoot(true)
          setSettling(true)
          startLootWaiting()
        }
        let ticket = parseBuyTicketFromReceipt(swapped)
        if (ticket.kind === 'none') {
          ticket = await recoverBuyTicket(publicClient, swapped)
        }
        if (ticket.kind === 'skipped') {
          closeLootDrop()
          setBusyLoot(false)
          setSettling(false)
          setLocalErr('Buy under 1 USDG skips the loot roll. Fee still goes to the pool.')
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
      }
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
    parsed,
    balance.data,
    side,
    poolFee,
    tickSpacing,
    publicClient,
    setOpen,
    switchChain,
    writeContractAsync,
    applyPayBalance,
    refreshPayBalance,
    allowance,
  ])

  const approveSpend = useCallback(
    async (value: bigint, mode: 'exact' | 'max') => {
      setLocalErr(null)
      if (!publicClient) {
        setLocalErr('RPC unavailable')
        return
      }
      try {
        setApproveMode(mode)
        setPendingKind('approve')
        const approveHash = await writeContractAsync({
          address: payToken,
          abi: erc20Abi,
          functionName: 'approve',
          args: [contracts.swapRouter, value],
        })
        const approved = await publicClient.waitForTransactionReceipt({ hash: approveHash })
        setPendingKind(null)
        setApproveMode(null)
        void allowance.refetch()
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
    [allowance, payToken, publicClient, writeContractAsync],
  )

  const payName = side === 'buy' ? 'USDG' : '$HOOKED'
  const getName = side === 'buy' ? '$HOOKED' : 'USDG'
  const payDot = side === 'buy' ? 'usdg' : 'hk'
  const getDot = side === 'buy' ? 'hk' : 'usdg'

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
          <span className="tok">
            <i className={`dot ${payDot}`} aria-hidden="true" /> {payName}
          </span>
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
              setUsdgAmount(next)
              setLastEdited('usdg')
            } else {
              setHookedAmount(next)
              setLastEdited('hooked')
            }
          }}
        />
        {side === 'sell' || (balLabel != null && isConnected) ? (
          <div className="pay-meta">
            {balLabel != null && isConnected ? (
              <span className={lowBalance ? 'bal low' : 'bal'}>bal {balLabel}</span>
            ) : (
              <span className="bal" />
            )}
            {side === 'sell' ? (
              <div className="pcts">
                <button type="button" disabled={!canFillSell} onMouseDown={(e) => e.preventDefault()} onClick={() => fillSell(2_500n)}>
                  25%
                </button>
                <button type="button" disabled={!canFillSell} onMouseDown={(e) => e.preventDefault()} onClick={() => fillSell(5_000n)}>
                  50%
                </button>
                <button type="button" disabled={!canFillSell} onMouseDown={(e) => e.preventDefault()} onClick={() => fillSell(10_000n)}>
                  max
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flip">
        <button
          type="button"
          onClick={() => setMode(side === 'buy' ? 'sell' : 'buy')}
          aria-label="Flip buy and sell"
        >
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
              if (parsed != null) void approveSpend(parsed, 'exact')
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
        <button className="go" id="swapBtn" type="button" disabled={disabled} onClick={submit}>
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
