import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.js'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/seasons.js', 'src/worker.js', 'src/nhl.js', 'src/pwhl.js'],
    },
  },
})
