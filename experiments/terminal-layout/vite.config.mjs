import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
export default defineConfig({
  plugins: [react(), { name: 'local-ghostty-wasm', generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'ghostty-vt.wasm', source: readFileSync(new URL('./node_modules/ghostty-web/ghostty-vt.wasm', import.meta.url)) })
  }, configureServer(server) {
    server.middlewares.use('/ghostty-vt.wasm', (_req, res) => {
      res.setHeader('Content-Type', 'application/wasm')
      res.end(readFileSync(new URL('./node_modules/ghostty-web/ghostty-vt.wasm', import.meta.url)))
    })
  } }],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { host: '127.0.0.1', port: 8766, strictPort: true }
})
