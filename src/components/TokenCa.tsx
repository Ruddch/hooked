import { useState } from 'react'
import { contracts } from '../config'

export function TokenCa() {
  const [copied, setCopied] = useState(false)
  const addr = contracts.mainToken

  const copy = async () => {
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)

    const fallback = () => {
      const el = document.createElement('textarea')
      el.value = addr
      el.setAttribute('readonly', '')
      el.style.position = 'fixed'
      el.style.left = '-9999px'
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    }

    try {
      if (!navigator.clipboard?.writeText) {
        fallback()
        return
      }
      await Promise.race([
        navigator.clipboard.writeText(addr),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('clipboard timeout')), 400)),
      ])
    } catch {
      try {
        fallback()
      } catch {
        /* ignore: UI still shows copied */
      }
    }
  }

  return (
    <button
      type="button"
      className={`ca-chip${copied ? ' on' : ''}`}
      onClick={() => void copy()}
      title={addr}
      aria-label={`Copy $HOOKED contract ${addr}`}
    >
      <span className="lab mono">CA</span>
      <span className="addr">{addr}</span>
      <span className="ok" aria-live="polite">
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  )
}
