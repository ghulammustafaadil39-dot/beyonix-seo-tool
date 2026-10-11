# Security Policy

**Contact:** security@beyonixsolutions.com
**Security.txt:** `/.well-known/security.txt` (RFC 9116, served by the API)

## Reporting a vulnerability

Email security@beyonixsolutions.com with:

- A description of the issue and the affected endpoint/version
- Steps to reproduce (proof of concept, no destructive testing against production)

We will acknowledge receipt, keep you informed while we investigate, and
credit you in the release notes if you wish.

## Scope

- The Beyonix SEO Tool API (`/api/v1/*`), worker, and web app
- Out of scope: third-party services (Stripe, Google, DataForSEO), social-engineering, physical attacks

## Ground rules

- Do not access, modify, or delete other users' data
- Do not perform denial-of-service testing
- Do not disclose the vulnerability publicly until we have had a reasonable time to fix it

## What we already do

See `docs/compliance/soc2-readiness.md` for the control inventory:
tenant isolation, encrypted secrets, 2FA, rate limiting, signed webhooks,
audit logs, retention controls, and a security review gate on every wave.
Email security contact: **security@beyonixsolutions.com** (replace with the
real address before public launch). Include: affected version/commit,
reproduction steps, and impact. We aim to acknowledge within 48h.

## Security model (implemented, Wave 1–2)

- **Auth**: bcrypt(12), JWT HS256 7d, `token_version` session revocation,
  TOTP 2FA (optional), email verification, password reset/change flows,
  session list + "log out everywhere", account/tenant delete with data purge.
- **Tenant isolation**: every tenant-owned query carries `tenant_id`; every
  tenant route uses `authPlugin`; cross-tenant access → 404 (no existence leak).
- **SSRF**: `safeFetch` pins DNS (single resolve, pinned IP), re-validates
  redirects, blocks IPv6 transition ranges + IP encodings, caps size/type,
  strips `Authorization`/`Cookie` on cross-origin redirects and https→http
  downgrades. Webhook URLs validated at registration AND per delivery.
- **Billing**: Stripe webhooks signature-mandatory in production; event
  idempotency ledger + `created` ordering guard; plan always from the Stripe
  price id (never client input); mock billing disabled in production.
- **Secrets**: `validateSecrets()` fail-fast (JWT ≥ 32 chars, no placeholders);
  stored OAuth/API keys AES-256-GCM with `kid` versioning + rotation script;
  `ENCRYPTION_KEY` never falls back to base64 in production.
- **Abuse**: Redis-backed per-IP + per-account rate limits, login lockout
  with backoff, signup CAPTCHA hook interface, per-tenant expensive-endpoint budgets.
- **Infra**: non-root read-only containers, digest-pinned images, Redis auth,
  no exposed DB ports, resource limits, `.dockerignore`.

## Scanning (CI)

- `npm audit --audit-level=high` (backend + frontend) — currently blocked
  locally by registry policy; CI must cover it.
- Gitleaks secret scan (`.gitleaks.toml`) on every push/PR.
- Trivy image scan (`trivy.yml`) — config-only here (no Docker daemon in
  this environment); runs in CI where Docker exists.

## Known limitations

- Trivy has never executed in the dev VM (no daemon); deferred to CI.
- GEO checks are simulations (see docs/methodology.md), not a security issue
  but a trust boundary: they must stay labeled.
