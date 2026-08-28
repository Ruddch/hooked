import { useEffect } from 'react'
import { ConnectButton } from '../components/ConnectWallet'
import { JackpotReadout } from '../components/JackpotReadout'
import { SiteFooter } from '../components/SiteFooter'
import { SwapCard } from '../components/SwapCard'
import { WinsList } from '../components/WinsList'
import { initDemoJack, initHomeFx } from '../fx/homeFx'

export function HomePage() {
  useEffect(() => {
    initHomeFx()
    initDemoJack()
  }, [])

  return (
    <>
      <canvas id="px-field" aria-hidden="true" />
      <main id="top">
        <section className="hero" id="hero">
          <div className="hero-head" id="heroHead">
            <div className="hero-connect">
              <ConnectButton />
            </div>
            <div className="hero-copy">
              <div className="hero-brand">
                <h1 className="wordmark" data-blobarrow>
                  <span className="line1">Swap.</span>
                  <span>
                    Get <span className="sel">hooked</span>.
                  </span>
                </h1>
              </div>
              <JackpotReadout />
            </div>
          </div>
          <div className="hero-stage">
            <SwapCard />
          </div>
        </section>

        <div className="sheet">
          <section className="ed" id="how">
            <div className="wrap">
              <div>
                <h2 id="loot" data-blobarrow>Loot is the swap.</h2>
                <p className="kick mono">How it works</p>
              </div>
              <div>
                <p>
                  You don’t just trade. You pull a lever. Base rate converts USDG → $HOOKED, then a random multiplier
                  lands: <strong>0.9×, 1×, 1.5×, 2×, 4×</strong> — or the <strong>jackpot</strong>. Same UX as a swap.
                  Different outcome every time.
                </p>
                <p>
                  Most rolls sit near fair. Some stretch. A rare few punch through into <strong>jackpot</strong>{' '}
                  territory — and the drop tells the story before the number does.
                </p>
              </div>
            </div>

            <div className="roulette" id="roulette">
              <div className="viz">
                <canvas id="roulette-cv" aria-hidden="true" />
              </div>
              <p className="cap mono">chance wheel · drag through it</p>
            </div>

            <div className="odds" id="odds">
              <div className="o coral">
                <p className="m">0.9×</p>
                <p className="l mono">scratch</p>
                <p>Slight haircut. Still a swap — just a spicy one.</p>
              </div>
              <div className="o deep">
                <p className="m">1×</p>
                <p className="l mono">even</p>
                <p>Break-even land. Quiet, clean, still a roll.</p>
              </div>
              <div className="o deep">
                <p className="m">1.5×</p>
                <p className="l mono">common</p>
                <p>Where most pluses land. Fair-ish, still a thrill.</p>
              </div>
              <div className="o mint">
                <p className="m">2×</p>
                <p className="l mono">heat</p>
                <p>You got hooked. The field goes mint.</p>
              </div>
              <div className="o mint">
                <p className="m">4×</p>
                <p className="l mono">heat</p>
                <p>Loud drop. The board lights up.</p>
              </div>
            </div>

            <div className="wins" id="wins">
              <div className="wrap">
                <div>
                  <h2>Recent wins</h2>
                  <p className="kick mono">live board</p>
                  <div className="two" id="moods">
                    <div className="c">
                      <svg className="smiley" viewBox="0 0 156 156" data-mood="happy" data-base="#00D4AA" aria-hidden="true" />
                      <div className="l mono">When it hits</div>
                    </div>
                    <div className="c">
                      <svg className="smiley" viewBox="0 0 156 156" data-mood="sad" data-base="#FF4D2E" aria-hidden="true" />
                      <div className="l mono">When it scratches</div>
                    </div>
                  </div>
                </div>
                <WinsList />
              </div>
            </div>
          </section>
        </div>

        <div className="marq-host" id="marqHost" aria-hidden="true" />

        <SiteFooter />
      </main>

      <div className="plinko" id="plinko" aria-live="polite">
        <div className="plinko-box">
          <div className="plinko-head">
            <p className="t">Loot drop</p>
            <p className="s mono" id="plinkoLive">
              falling…
            </p>
          </div>
          <canvas id="plinko-cv" width={460} height={540} />
          <div className="plinko-result">
            <p className="phase mono" id="pkPhase">
              drop the ball
            </p>
            <p className="mult" id="pkMult">
              —
            </p>
            <p className="amt" id="pkAmt" />
            <button className="again" id="pkClose" type="button">
              Swap again
            </button>
          </div>
        </div>
      </div>

      <div className="jack-reveal" id="jackReveal" aria-live="polite">
        <canvas className="jr-pixels" id="jrPixels" aria-hidden="true" />
        <div className="jr-flash" aria-hidden="true" />
        <div className="jr-core">
          <p className="jr-label">jackpot triggered</p>
          <p className="jr-amt" id="jrAmt">
            $0
          </p>
          <button className="jr-ok" id="jrOk" type="button">
            Nice
          </button>
        </div>
      </div>

      <div id="demo-cursor" aria-hidden="true">
        <i className="ring" />
      </div>
    </>
  )
}
