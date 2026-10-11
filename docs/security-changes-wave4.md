# Security behavior notes (Wave-4 verified)

Verified-in-code behaviors that changed (or were hardened) during Wave 4's
hostile-audit loop. Every claim below cites the code that proves it.

## 1. Team roles gate mutations

Mutating routes carry role/scope pre-handlers. The significant Wave-3/4
change: `PATCH /settings` is gated **whole-route** with
`requireRole('owner', 'admin')` — a viewer or editor cannot change the LLM
cost cap, overwrite a tenant BYOK key, or alter provider selection
(`backend/src/routes/settings.ts:64`). Read-only access (`GET /settings`,
`GET /settings/providers`, `GET /usage`) uses `settings:read`.

Other sensitive routes follow the same pattern via
`backend/src/middleware/access.ts` (`requireScope(...)` /
`requireRoleOrScope(...)`).

## 2. BYOK fail-closed (A2-H1)

`getLLM(override?, apiKey?)` **throws** when an `apiKey` is supplied without
an explicit provider — the server never guesses a provider for a key, so a
tenant's credential can never be disclosed to the wrong third party
(`backend/src/providers/llm.ts`, `getLLM`).

`getLLMForTenant()` extends this: if a tenant stored `llm_api_key_enc` but
`llm_provider` is unset, the BYOK key is **ignored with a warning** (never
sent anywhere) and the account-level provider selection is used instead
(`backend/src/providers/llm.ts`, `getLLMForTenant`).

Operator note: to use BYOK, set **both** `llm_provider` (gemini|openai) and
the key via the settings UI. Setting only the key silently does nothing —
this is intentional.

## 3. Impersonation via server-side httpOnly cookie (A3-H1)

Admin impersonation no longer touches `document.cookie`:

1. `POST /api/v1/admin/impersonate` (backend, platform-admin only, CSRF
   guarded) returns `{ token, tenantId, expiresInSec: 300 }` as JSON — a
   5-minute JWT for the tenant's owner, registered as a revocable session
   (`admin-impersonation`) and written to the admin audit log
   (`backend/src/routes/admin.ts`).
2. The browser calls the Next.js same-origin route
   `POST /api/admin/impersonate`, which forwards the admin's session cookies
   + CSRF header to the API, then sets the token on the browser **only as
   an httpOnly Set-Cookie** (flags mirror the API cookie policy; `Secure`
   in production). The response body never contains the token
   (`frontend/app/api/admin/impersonate/route.ts`).

The only `document.cookie` read remaining in the frontend is the
deliberately JS-readable `bseo_csrf` cookie (CSRF double-submit pattern);
`bseo_token` itself is never readable by JS.

## 4. Billing portal scope (B1-M2)

`POST /billing/portal` requires `owner`/`admin` role **or** the
`billing:write` scope (`requireRoleOrScope(['owner', 'admin'],
'billing:write')` in `backend/src/routes/billing.ts`). Rationale: a portal
URL grants full billing management (cancel, plan change), so a read-only
user must not be able to mint one. Invoices/subscription reads use
`billing:read`.

## 5. Mock-provider fail-closed matrix

| Provider | Production without credentials |
|---|---|
| Stripe | `DisabledPaymentsProvider` → 503 `BILLING_NOT_CONFIGURED` (`backend/src/providers/stripe.ts`) |
| Google OAuth/GSC | throws FATAL; mock allowed only in test/development (`backend/src/providers/google.ts`, `isMockGoogleAllowed()`) |
| DataForSEO | deterministic seeded mock (`dataSource: 'mock'`) |
| LLM | template mock |
| Mock Stripe webhooks / mock-confirm routes | disabled in production (`mockBillingRoutesEnabled()`, `P0-05`) |
| CAPTCHA `test` provider | refused in production; falls back to `none` with an error log (`backend/src/providers/captcha.ts`) |
| CMS publish | no-op mock unless `CMS_PUBLISH_ENABLED=true` (`backend/src/services/publishConnector.ts`) |

## 6. Secrets and rotation

- `validateSecrets()` fails boot when any required secret is missing,
  shorter than 32 chars, or a placeholder — in every env except
  dev/test (`backend/src/config.ts`, `P0-05`).
- Encryption keys are versioned (`kid`); rotation script:
  `backend/scripts/rotate-encryption-keys.ts`.
- GDPR export redacts bearer tokens (Slack webhook URLs, query-param
  secrets, Zapier/Discord path secrets) (`W-07`, pass-#1 follow-up).
