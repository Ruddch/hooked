import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatUnits, parseUnits, UserRejectedRequestError } from 'viem'
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from 'wagmi'
import { erc20Abi } from '../abi/erc20'
import { hookedV1Abi, poolSwapTestAbi } from '../abi/hooked'
import { robinhood } from '../chain'
import { contracts, tokenMeta } from '../config'
import { closeLootDrop, startLootDrop, startLootWaiting } from '../fx/homeFx'
import {
  LootTimeoutError,
  parseBuyTicketFromReceipt,
  toLootDrop,
  waitForLootSettle,
} from '../lib/lootSettle'
import { poolManagerAbi, poolStateSlot, quoteExactIn, sqrtPriceX96FromSlot0 } from '../lib/poolQuote'
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

export function SwapCard() {
  const { address, isConnected, chainId } = useAccount()
  const { setOpen } = useWalletUi()
  const { switchChain, isPending: switching } = useSwitchChain()
  const publicClient = usePublicClient({ chainId: robinhood.id })
  const { writeContractAsync, isPending: writing, error: writeError } = useWriteContract()
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const [busyLoot, setBusyLoot] = useState(false)
  const [settling, setSettling] = useState(false)
  const [pendingKind, setPendingKind] = useState<'approve' | 'swap' | null>(null)
  const [localErr, setLocalErr] = useState<string | null>(null)

  const payToken = side === 'buy' ? contracts.usdg : contracts.mainToken
  const payDecimals = side === 'buy' ? tokenMeta.usdgDecimals : tokenMeta.mainDecimals
  const parsed = parseLoose(amount, payDecimals)
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
    query: { enabled: Boolean(address), refetchInterval: 12_000 },
  })

  const allowance = useReadContract({
    address: payToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, contracts.swapRouter] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 8_000 },
  })

  const slot0 = useReadContract({
    address: contracts.poolManager,
    abi: poolManagerAbi,
    functionName: 'extsload',
    args: [poolStateSlot(contracts.poolId)],
    query: { retry: false, refetchInterval: 12_000 },
  })

  const poolFee = fee.data ?? contracts.poolFee
  const tickSpacing = spacing.data ?? contracts.tickSpacing
  const needsApprove = parsed != null && (allowance.data ?? 0n) < parsed
  const humanIn = Number(amount) || 0
  const outDecimals = side === 'buy' ? tokenMeta.mainDecimals : tokenMeta.usdgDecimals

  const quote = useMemo(() => {
    if (parsed == null || !slot0.data) return null
    const sqrtP = sqrtPriceX96FromSlot0(slot0.data)
    const { net } = quoteExactIn(parsed, sqrtP, side === 'buy')
    if (net <= 0n) return null
    const base = Number(formatUnits(net, outDecimals))
    if (!Number.isFinite(base) || base <= 0) return null
    return base
  }, [parsed, slot0.data, side, outDecimals])

  const outLow = quote != null && side === 'buy' ? fmtRange(quote * 0.9) : '—'
  const outHigh = quote != null && side === 'buy' ? fmtRange(quote * 4) : '—'
  const sellOut = quote != null && side === 'sell' ? fmtRange(quote) : '—'

  const setMode = (next: 'buy' | 'sell') => {
    setSide(next)
    setLocalErr(null)
  }

  const canFillSell = Boolean(isConnected && balance.data != null && balance.data > 0n)

  const fillSell = (bps: bigint) => {
    if (balance.data == null || balance.data <= 0n) return
    const raw = bps >= 10_000n ? balance.data : (balance.data * bps) / 10_000n
    if (raw <= 0n) return
    setAmount(trimUnits(formatUnits(raw, payDecimals)))
    setLocalErr(null)
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
    if (!(humanIn > 0)) return side === 'buy' ? 'Swap & drop' : 'Sell'
    if (needsApprove) return side === 'buy' ? 'Approve USDG' : 'Approve $HOOKED'
    return side === 'buy' ? 'Swap & drop' : 'Sell'
  })()

  const disabled = writing || pendingKind != null || busyLoot || switching

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
    const token = payToken

    try {
      if (needsApprove) {
        setPendingKind('approve')
        const approveHash = await writeContractAsync({
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [contracts.swapRouter, amountIn],
        })
        const approved = await publicClient.waitForTransactionReceipt({ hash: approveHash })
        if (approved.status === 'reverted') {
          setPendingKind(null)
          setLocalErr('Approve failed')
          return
        }
      }

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
      void balance.refetch()
      void allowance.refetch()
      if (swapped.status === 'reverted') {
        setLocalErr('Transaction failed')
        return
      }
      if (zeroForOne) {
        const ticket = parseBuyTicketFromReceipt(swapped)
        if (ticket.kind !== 'open' || !address || swapped.blockNumber == null) return

        setBusyLoot(true)
        setSettling(true)
        startLootWaiting()
        const ac = new AbortController()
        const onClosed = () => ac.abort()
        window.addEventListener('hooked:plinko-closed', onClosed)
        try {
          const settle = await waitForLootSettle({
            client: publicClient,
            buyId: ticket.buyId,
            fromBlock: swapped.blockNumber,
            signal: ac.signal,
          })
          if (ac.signal.aborted) return
          setSettling(false)
          startLootDrop(toLootDrop(ticket, settle))
          window.dispatchEvent(new CustomEvent('hooked:loot-settled'))
          void balance.refetch()
        } catch (lootErr) {
          if (ac.signal.aborted || (lootErr instanceof DOMException && lootErr.name === 'AbortError')) return
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
    needsApprove,
    payToken,
    side,
    poolFee,
    tickSpacing,
    publicClient,
    setOpen,
    switchChain,
    writeContractAsync,
    balance,
    allowance,
  ])

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
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        {side === 'sell' || (balLabel != null && isConnected) ? (
          <div className="pay-meta">
            {balLabel != null && isConnected ? <span className="bal">bal {balLabel}</span> : <span className="bal" />}
            {side === 'sell' ? (
              <div className="pcts">
                <button type="button" disabled={!canFillSell} onClick={() => fillSell(2_500n)}>
                  25%
                </button>
                <button type="button" disabled={!canFillSell} onClick={() => fillSell(5_000n)}>
                  50%
                </button>
                <button type="button" disabled={!canFillSell} onClick={() => fillSell(10_000n)}>
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
        <a className="jack-tease" href="#odds" data-scroll-odds>
          <i className="spark" aria-hidden="true" />
          <span>
            every swap can hit the <b>jackpot</b>
          </span>
        </a>
      ) : (
        <p className="sell-note">Sells skip the loot roll. Fee goes to jackpot and ops.</p>
      )}
      <button className="go" id="swapBtn" type="button" disabled={disabled} onClick={submit}>
        <span className="pxfx" aria-hidden="true" />
        <span className="lbl">{label}</span>
      </button>
      {err ? <p className="err">{err}</p> : null}
      {side === 'buy' ? (
        <a className="hint" href="#odds" data-scroll-odds>
          view my odds
        </a>
      ) : null}
    </div>
  )
}
