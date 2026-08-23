import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function pagesBase(): string {
  if (process.env.BASE_PATH) return process.env.BASE_PATH
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
  const owner = process.env.GITHUB_REPOSITORY_OWNER
  if (repo && owner && repo !== `${owner}.github.io`) return `/${repo}/`
  return '/'
}

export default defineConfig({
  plugins: [react()],
  base: pagesBase(),
})
