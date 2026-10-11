import { chromium } from 'playwright-core';

const BASE = 'http://localhost:3000';
const results = [];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'], timeout: 30000 });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.setDefaultTimeout(20000);

async function step(name, fn) {
  try { await fn(); results.push([name, 'PASS']); console.log('PASS', name); }
  catch (e) { results.push([name, 'FAIL: ' + e.message.split('\n')[0]]); console.log('FAIL', name, e.message.split('\n')[0]); }
}

// Journey 1: login with seeded demo account -> dashboard shows demo site
await step('login demo -> dashboard shows seeded site', async () => {
  await page.goto(BASE + '/login');
  await page.fill('input[type="email"]', 'demo@beyonix.local');
  await page.fill('input[type="password"]', 'DemoPass123!');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  await page.waitForLoadState('networkidle');
  const body = await page.textContent('body');
  if (!/example\.com/i.test(body)) throw new Error('seeded site example.com not visible on dashboard');
});

// Journey 2: billing page renders subscription data
await step('billing page renders', async () => {
  await page.goto(BASE + '/dashboard/billing');
  await page.waitForLoadState('networkidle');
  const body = (await page.textContent('body')) ?? '';
  if (!/plan|subscription|billing/i.test(body)) throw new Error('no billing content');
});

// Journey 3: logout -> login again (P0-01 regression at UI level)
await step('logout then login again', async () => {
  const logoutBtn = page.getByRole('button', { name: /log\s?out|sign\s?out/i });
  if (await logoutBtn.count() > 0) {
    await logoutBtn.first().click();
    await page.waitForURL(/\/login$/, { timeout: 15000 });
  } else {
    // fallback: clear cookies to simulate logout
    await ctx.clearCookies();
    await page.goto(BASE + '/login');
  }
  await page.waitForLoadState('networkidle');
  await page.fill('input[type="email"]', 'demo@beyonix.local');
  await page.fill('input[type="password"]', 'DemoPass123!');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
});

// Journey 4: signup a fresh user -> lands on dashboard
await step('signup fresh user -> dashboard', async () => {
  await ctx.clearCookies();
  const email = `e2e+${Date.now()}@beyo.test`;
  await page.goto(BASE + '/signup');
  await page.fill('input[type="text"]', 'E2E User');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'Str0ng!E2e-' + Date.now());
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
});

// Journey 5: /status page renders service data
await step('/status page renders', async () => {
  await page.goto(BASE + '/status');
  await page.waitForLoadState('networkidle');
  const body = (await page.textContent('body')) ?? '';
  if (!/Operational|Degraded|Database/i.test(body)) throw new Error('status content missing');
});

await browser.close();
const fails = results.filter((r) => r[1] !== 'PASS');
console.log(`\nE2E: ${results.length - fails.length}/${results.length} passed`);
if (fails.length) { process.exitCode = 1; }
