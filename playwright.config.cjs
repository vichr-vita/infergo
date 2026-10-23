const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/ui',
  globalSetup: './tests/ui/setup.cjs',
  reporter: 'list',
  use: { headless: true, viewport: { width: 1440, height: 900 } },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
