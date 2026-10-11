# E2E Playwright attempt — Wave 3 Q-01(c)

See `docs/qa/wave3-results.md` for the executed outcome. This file records
the intended journeys so a later environment (with a working Chromium)
can run them:

1. signup → login → onboarding (`/dashboard/sites/new`):
   verify site → connect GSC (mock) → first audit
2. billing page (`/dashboard/billing`): checkout → mock-confirm →
   subscription shows plan; invoices listed
3. logout → login again (P0-01 regression at UI level)

Playwright scripts should target the built frontend (`npm run build &&
npm run start`) + a seeded backend (`npm run seed` on a disposable test
database) and use a fresh browser context per journey.
