import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'node',
    // Task-authority race tests spawn helper processes (kill -9 recovery,
    // two-writer claim arbitration) that can exceed the default 5s budget.
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
