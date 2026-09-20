import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  testDir: './browser-tests',
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:8092',
    viewport: { width: 393, height: 852 },
    launchOptions: process.env.CHROMIUM_PATH ? {
      executablePath: process.env.CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    } : {},
  },
  webServer: {
    command: 'node src/server.js',
    url: 'http://127.0.0.1:8092/api/health',
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'test', HOST: '0.0.0.0', PORT: '8092', SEED_DEMO_ON_BOOT: '1',
      DB_PATH: path.join(os.tmpdir(), `kivo-browser-${process.pid}.db`),
      UPLOAD_DIR: path.join(os.tmpdir(), `kivo-browser-uploads-${process.pid}`),
    },
  },
});
