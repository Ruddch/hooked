export function SiteFooter() {
  return (
    <footer className="foot">
      <span className="mono">stay hooked</span>
      <div className="foot-links">
        <a
          className="foot-doc mono"
          href="https://whitepaper.hooked.work/"
          target="_blank"
          rel="noopener noreferrer"
        >
          whitepaper
        </a>
        <a className="foot-icon" href="https://x.com/" target="_blank" rel="noopener noreferrer" aria-label="X / Twitter">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"
            />
          </svg>
        </a>
      </div>
    </footer>
  )
}
