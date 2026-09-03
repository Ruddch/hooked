import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const rootDir = dirname(fileURLToPath(import.meta.url))

function cnameHost(): string | undefined {
  try {
    const raw = readFileSync(join(rootDir, 'public/CNAME'), 'utf8').trim().split(/\s+/)[0]
    return raw || undefined
  } catch {
    return undefined
  }
}

function isGithubIoHost(host: string): boolean {
  return host === 'github.io' || host.endsWith('.github.io')
}

/** Custom domains (hooked.work) are served at `/`. Project Pages stay `/<repo>/`. */
function pagesBase(): string {
  if (process.env.BASE_PATH) return process.env.BASE_PATH
  if (cnameHost()) return '/'
  const site = process.env.VITE_SITE_URL
  if (site) {
    try {
      const host = new URL(site.includes('://') ? site : `https://${site}`).hostname
      if (!isGithubIoHost(host)) return '/'
    } catch {
      /* ignore */
    }
  }
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
  const owner = process.env.GITHUB_REPOSITORY_OWNER
  if (repo && owner && repo !== `${owner}.github.io`) return `/${repo}/`
  return '/'
}

function siteOrigin(): string | undefined {
  const explicit = process.env.VITE_SITE_URL?.replace(/\/$/, '')
  if (explicit) return explicit
  const cname = cnameHost()
  if (cname) return `https://${cname}`
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
  const owner = process.env.GITHUB_REPOSITORY_OWNER
  if (!repo || !owner) return undefined
  return repo === `${owner}.github.io`
    ? `https://${owner}.github.io`
    : `https://${owner}.github.io/${repo}`
}

function absolutizeShareImage(): Plugin {
  return {
    name: 'absolutize-share-image',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const origin = siteOrigin()
        if (!origin) return html
        return html.replaceAll(/content="[^"]*share\.png"/g, `content="${origin}/share.png"`)
      },
    },
  }
}

export default defineConfig({
  plugins: [react(), absolutizeShareImage()],
  base: pagesBase(),
})
