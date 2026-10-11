import { chromium } from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';

const BASE = 'http://localhost:3000';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.setDefaultTimeout(20000);

// login first so we can scan authenticated pages too
await page.goto(BASE + '/login');
await page.fill('input[type="email"]', 'demo@beyonix.local');
await page.fill('input[type="password"]', 'DemoPass123!');
await page.click('button[type="submit"]');
await page.waitForURL(/\/dashboard/, { timeout: 20000 });

const targets = ['/login', '/signup', '/dashboard', '/dashboard/billing', '/status'];
for (const t of targets) {
  try {
    await page.goto(BASE + t);
    await page.waitForLoadState('networkidle');
    const res = await new AxeBuilder({ page }).analyze();
    const serious = res.violations.filter((v) => ['critical', 'serious'].includes(v.impact));
    console.log(`${t}: ${res.violations.length} total violations, ${serious.length} critical/serious`);
    for (const v of serious.slice(0, 5)) {
      console.log(`  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes)`);
    }
  } catch (e) {
    console.log(`${t}: SCAN_FAILED ${e.message.split('\n')[0]}`);
  }
}
await browser.close();
