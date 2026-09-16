import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Each test file builds its own in-memory DB — run files serially for
    // deterministic port-free behavior; they're independent anyway.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
