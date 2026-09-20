import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 45000,
    hookTimeout: 45000,
    retry: process.env.CI ? 1 : 0,
    // Each test file builds its own in-memory DB — run files serially for
    // deterministic port-free behavior; they're independent anyway.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: process.env.CI ? ['verbose'] : ['default'],
  },
});
