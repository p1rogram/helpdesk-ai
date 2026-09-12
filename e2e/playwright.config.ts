import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * AI: Сквозной тест «как пользователь»: поднимает API на PGlite без модели (детерминированный
 * упрощённый режим) и dev-сервер сайта, затем проходит путь студент -> вопрос -> заявка ->
 * ответ оператора в реальном браузере. Запуск: `npm run e2e` (нужен `npx playwright install chromium`).
 */
const root = path.resolve(here, '..');
const apiEnv = {
  PORT: '8089',
  HOST: '127.0.0.1',
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  // AI: Модель выключена намеренно: путь без LLM детерминирован и не тратит бюджет в CI.
  ANTHROPIC_API_KEY: '',
  LLM_API_KEY: '',
  LLM_PROVIDER: 'anthropic',
  RAG_ENABLED: 'false',
  EVENT_BUS: 'memory',
  TELEGRAM_BOT_TOKEN: '',
  WEB_DEMO_LOGIN: 'true',
  WEB_GUEST_LOGIN: 'true',
  OPERATOR_OPEN_ACCESS: 'true',
  JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-32',
  PGLITE_DIR: mkdtempSync(path.join(tmpdir(), 'helpdesk-e2e-')),
};

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    locale: 'ru-RU',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx src/index.ts',
      cwd: path.join(root, 'apps/api'),
      url: 'http://127.0.0.1:8089/health',
      timeout: 120_000,
      reuseExistingServer: false,
      env: { ...process.env, ...apiEnv },
    },
    {
      command: 'npx vite --port 5199 --strictPort --host 127.0.0.1',
      cwd: path.join(root, 'apps/web'),
      url: 'http://127.0.0.1:5199',
      timeout: 120_000,
      reuseExistingServer: false,
      env: { ...process.env, VITE_API_PROXY: 'http://127.0.0.1:8089' },
    },
  ],
});
