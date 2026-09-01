# Hooked web

Vite + React dapp for the Hooked landing: injected wallets (EIP-6963), Robinhood Chain reads, Uniswap v4 swap via the deployed `PoolSwapTest` router. Plinko / jackpot reveal stay theatrical after a confirmed tx.

## Run

```bash
cd web
cp .env.example .env
npm install
npm run dev
```

Open http://localhost:5173

## GitHub Pages

Push this folder as the repository root (the app, not a parent monorepo). On GitHub: **Settings → Pages → Source: GitHub Actions**. The workflow in `.github/workflows/deploy.yml` builds on every push to `main`/`master` and publishes `dist`.

The site URL is `https://<user>.github.io/<repo>/`. Vite sets `base` from the repo name automatically in CI. For a user/org site (`<user>.github.io`) or a custom domain, the base stays `/`.

## Env

Copy [.env.example](.env.example) for local `.env` (gitignored). GitHub Pages / `npm run build` read committed [.env.production](.env.production) — HookedV1 listing 5.

Wallets: only browser extensions (MetaMask, Rabby, OKX, …). No WalletConnect project id.

Whitepaper lives at [whitepaper.hooked.work](https://whitepaper.hooked.work/).
