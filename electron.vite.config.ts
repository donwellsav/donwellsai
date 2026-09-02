import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { external: ['electron', 'node-pty'], input: { index: resolve('src/main/index.ts'), 'terminal-daemon-entry': resolve('src/main/terminal-daemon-entry.ts') }, output: { format: 'cjs', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' } } }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { external: ['electron'] } }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()]
  }
})