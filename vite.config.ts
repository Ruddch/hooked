import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function pagesBase(): string {
  if (process.env.BASE_PATH) return process.env.BASE_PATH
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
  const owner = process.env.GITHUB_REPOSITORY_OWNER
  if (repo && owner && repo !== `${owner}.github.io`) return `/${repo}/`
  return '/'
}

function siteOrigin(): string | undefined {
  const explicit = process.env.VITE_SITE_URL?.replace(/\/$/, '')
  if (explicit) return explicit
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
