import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'

const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.SKYSHIFT_BASE_URL ?? 'http://localhost:8080',
    browserName: 'chromium',
    launchOptions: {
      executablePath: process.env.CHROME_PATH ?? (existsSync(macChrome) ? macChrome : undefined),
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
