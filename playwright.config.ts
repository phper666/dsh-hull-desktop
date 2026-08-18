import { defineConfig } from '@playwright/test';

/**
 * S7 e2e 配置（Playwright _electron）：
 * - testDir tests/e2e（TS 源直跑，Playwright 自带转译；tsc 仅负责编译 app 本体 dist/）
 * - workers=1 串行：单实例锁 + 共享 npm 缓存/端口资源；每测试独立临时 userData（CON-R002 精神）
 * - 慢测试（E2E-02 真实 npm install ~234s）在用例内 test.setTimeout 覆盖
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});