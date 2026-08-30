/**
 * Playwright E2E against the LIVE dev deployment, phone-first (390x844).
 * Run: AWS_PROFILE=openswitchboard npm run test:e2e
 * (needs the openswitchboard AWS profile: RDS Data API + Secrets Manager
 * observability for SES-sandbox-era verification codes; see counter/email.ts)
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 300_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    viewport: { width: 390, height: 844 }, // phone-first gate
    baseURL: process.env.OSB_COUNTER_URL ?? 'https://counter-dev.openswitchboard.ai',
    screenshot: 'only-on-failure',
  },
});
