import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  testDir: './browser-tests',
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8092',
    viewport: { width: 393, height: 852 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: process.env.CHROMIUM_PATH ? {
      executablePath: process.env.CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    } : {
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },
  webServer: {
    command: 'node src/server.js',
    url: 'http://127.0.0.1:8092/api/health',
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      NODE_ENV: 'test', HOST: '0.0.0.0', PORT: '8092', SEED_DEMO_ON_BOOT: '1',
      DB_PATH: path.join(os.tmpdir(), `kivo-browser-${process.pid}.db`),
      UPLOAD_DIR: path.join(os.tmpdir(), `kivo-browser-uploads-${process.pid}`),
    },
  },
});
