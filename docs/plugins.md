# Plugin Interface (W-06)

Minimal internal plugin contract. Plugins hook around **audit completion**
and **report generation**. Hooks fire in the **worker** process; a failing
plugin never breaks the job that triggered it (errors are caught + logged
per plugin).

```ts
import { registerPlugin } from '../backend/src/services/plugins.js';

registerPlugin({
  name: 'my-plugin',
  async onAuditComplete({ tenantId, siteId, resourceId, payload }) {
    // payload: { score, lightCheck? }
  },
  async onReportGenerated({ tenantId, siteId, resourceId, payload }) {
    // payload: { periodStart, periodEnd }
  },
});
```

- Register built-ins with `registerDefaultPlugins()` (called from `worker.ts`).
- `listPlugins()` / `clearPluginsForTests()` for introspection and tests.

## Reference plugin: `slack-notify-on-audit-complete`

Delivered **through the existing signed webhook system** (F-10) — not a
parallel notify path. A tenant subscribes a Slack incoming-webhook bridge
URL to the `audit.completed` event (`POST /api/v1/webhooks`); the plugin
emits that event on every audit completion, and the existing pipeline
handles signed delivery, retries (5 attempts over ~15h), an overall 30s
per-attempt deadline, and manual replay from `/webhooks/deliveries`.

## Webhook event catalog

`GET /api/v1/webhooks/events` returns the fixed catalog (also served in the
generated OpenAPI spec via the recorded route):

`audit.completed`, `rank.changed`, `report.ready`, `invoice.paid`,
`invoice.payment_failed`, `subscription.updated`, `limit.near`, `site.down`,
`issue.critical`, `notify.rank_drop`, `notify.critical_issue`,
`notify.site_down`, `notify.limit_near`.

Delivery is signed `X-BSEO-Signature: sha256=<hmac(secret, "<ts>.<body>")>`
(verify with `verifyWebhookSignature`); retries and replay verified by the
existing F-10 test suite — not rebuilt in Wave 3.
