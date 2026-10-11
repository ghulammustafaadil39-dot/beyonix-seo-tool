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
