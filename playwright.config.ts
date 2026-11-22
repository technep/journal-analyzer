import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'

const systemChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined)

export default defineConfig({
  testDir: './tests',
  testMatch: 'browser.spec.ts',
  outputDir: './tests/results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4187',
    browserName: 'chromium',
    headless: true,
    timezoneId: 'UTC',
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    launchOptions: {
      executablePath: systemChromium,
    },
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4187',
    url: 'http://127.0.0.1:4187',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
