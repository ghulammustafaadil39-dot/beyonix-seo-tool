// Single place for all env config. Never read process.env elsewhere.
function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env: ${name}`);
  return v;
}
function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  // Fail-closed default: an operator who forgets NODE_ENV gets production
  // behavior (no mocks, strict secrets) instead of a dev-mode server.
  nodeEnv: opt('NODE_ENV', 'production'),
  port: parseInt(opt('PORT', '4000'), 10),
  databaseUrl: opt('DATABASE_URL', 'postgres://bseo:bseo@localhost:5432/bseo'),
  redisUrl: opt('REDIS_URL', 'redis://localhost:6379'),
  // S-03: which proxies to trust for req.ip / X-Forwarded-For. Default FALSE
  // (fail closed): behind a proxy the operator sets TRUST_PROXY=true (or a
  // hop count like "1") so per-IP rate limits key on the real client IP
  // instead of the proxy's. Trusting a proxy you don't control lets an
  // attacker spoof X-Forwarded-For and dodge IP rate limits.
  trustProxy: parseTrustProxy(opt('TRUST_PROXY', '')),
  // S-03: global per-IP rate limit (Redis-backed, shared across instances).
  globalRateLimitPerMin: parseInt(opt('RATE_LIMIT_PER_MIN', '300'), 10),
  // S-03: login lockout with exponential backoff (Redis-backed).
  loginLockout: {
    maxAttempts: parseInt(opt('LOGIN_LOCKOUT_MAX_ATTEMPTS', '5'), 10),
    baseLockoutMin: parseInt(opt('LOGIN_LOCKOUT_BASE_MIN', '5'), 10),
    maxLockoutMin: parseInt(opt('LOGIN_LOCKOUT_MAX_MIN', '60'), 10),
  },
  // S-03: signup abuse protection.
  disposableEmailBlock: opt('DISPOSABLE_EMAIL_BLOCK', 'false') === 'true',
  captchaProvider: opt('CAPTCHA_PROVIDER', 'none'),
  captchaSecret: opt('CAPTCHA_SECRET', ''),
  captchaSiteKey: opt('CAPTCHA_SITEKEY', ''),
  // S-03: per-tenant hourly budget for expensive endpoints
  // (keyword research, content generation). Re-read per request via a live
  // env fallback so tests/ops can tune it without a reboot.
  tenantExpensiveLimitPerHour: parseInt(opt('TENANT_EXPENSIVE_LIMIT_PER_HOUR', '30'), 10),
  // S-06: cookie/CSRF/CORS hardening knobs.
  cookieSameSite: opt('COOKIE_SAMESITE', 'lax'),
  corsOrigins: opt('CORS_ORIGINS', ''),
  jwtSecret: opt('JWT_SECRET', 'dev-only-jwt-secret-change-me'),
  // S-04: HMAC secret for the signed OAuth-state binding cookie. Falls back
  // to the JWT secret so the binding is never unsigned by misconfiguration —
  // but operators should set a dedicated value (see .env.example).
  cookieSecret: opt('COOKIE_SECRET', ''),
  // Local signing secret for the mock Stripe webhook (dev/test only).
  // Mock webhooks are rejected when this is unset, and always in production.
  mockWebhookSecret: opt('MOCK_WEBHOOK_SECRET', ''),
  appUrl: opt('APP_URL', 'http://localhost:3000').replace(/\/$/, ''),
  apiUrl: opt('API_URL', 'http://localhost:4000').replace(/\/$/, ''),
  encryptionKey: opt('ENCRYPTION_KEY', ''),
  // S-07: key versioning — "kid:hex,kid:hex,...", first entry is primary.
  // When set, it takes precedence over the legacy single ENCRYPTION_KEY.
  encryptionKeys: opt('ENCRYPTION_KEYS', ''),

  stripeSecretKey: opt('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: opt('STRIPE_WEBHOOK_SECRET'),
  stripePrices: {
    starter: opt('STRIPE_PRICE_STARTER'),
    growth: opt('STRIPE_PRICE_GROWTH'),
    pro: opt('STRIPE_PRICE_PRO'),
  } as Record<string, string>,

  googleClientId: opt('GOOGLE_CLIENT_ID'),
  googleClientSecret: opt('GOOGLE_CLIENT_SECRET'),
  googleRedirectUri: opt('GOOGLE_REDIRECT_URI', 'http://localhost:4000/api/v1/gsc/callback'),

  dataforseoLogin: opt('DATAFORSEO_LOGIN'),
  dataforseoPassword: opt('DATAFORSEO_PASSWORD'),

  llmProvider: opt('LLM_PROVIDER') as '' | 'gemini' | 'openai',
  geminiApiKey: opt('GEMINI_API_KEY'),
  geminiModel: opt('GEMINI_MODEL', 'gemini-2.0-flash'),
  openaiApiKey: opt('OPENAI_API_KEY'),
  openaiModel: opt('OPENAI_MODEL', 'gpt-4o-mini'),

  smtpHost: opt('SMTP_HOST'),
  smtpPort: parseInt(opt('SMTP_PORT', '587'), 10),
  smtpUser: opt('SMTP_USER'),
  smtpPass: opt('SMTP_PASS'),
  smtpFrom: opt('SMTP_FROM', 'Beyonix SEO <noreply@beyonixseo.com>'),

  telegramBotToken: opt('TELEGRAM_BOT_TOKEN'),
  // F-04: CMS publish connector (WordPress/Webflow). Off by default;
  // when off, publish endpoints run in honest mock mode (publishConnector).
  cmsPublishEnabled: opt('CMS_PUBLISH_ENABLED', 'false') === 'true',
  // Q-03: env-gated observability hooks (documented, no hard dependency).
  // When SENTRY_DSN is set, the operator initialises Sentry around the
  // process; when OTEL_EXPORTER_OTLP_ENDPOINT is set, an OTel collector
  // export pipeline can be attached. The app itself ships pino JSON logs
  // (Fastify logger) + GET /metrics and GET /status.
  sentryDsn: opt('SENTRY_DSN', ''),
  otelEndpoint: opt('OTEL_EXPORTER_OTLP_ENDPOINT', ''),
};

export const hasStripe = () => !!config.stripeSecretKey;
export const hasGoogle = () => !!(config.googleClientId && config.googleClientSecret);
export const hasDataForSeo = () => !!(config.dataforseoLogin && config.dataforseoPassword);
export const hasSmtp = () => !!(config.smtpHost && config.smtpUser);
export const hasTelegram = () => !!config.telegramBotToken;

// N-A2-6: a deploy with Stripe keys but no webhook secret would 500 every
// incoming webhook into a Stripe retry storm. Fail fast at boot instead
// (all environments — dev with real keys hits the same storm).
if (config.stripeSecretKey && !config.stripeWebhookSecret) {
  throw new Error('FATAL: STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set');
}

// S-03: parses TRUST_PROXY. 'true' -> true (trust all hops — only behind a
// proxy you control), a hop count ('1', '2') -> that number, anything else
// (including '') -> false (fail closed: X-Forwarded-For is ignored).
export function parseTrustProxy(raw: string): boolean | number {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) {
    const n = parseInt(v, 10);
    return n > 0 ? n : false;
  }
  return false;
}

/** S-03: live re-read of the per-tenant expensive-endpoint budget. */
export function tenantExpensiveLimit(): number {
  const v = parseInt(process.env.TENANT_EXPENSIVE_LIMIT_PER_HOUR ?? '', 10);
  if (Number.isFinite(v) && v > 0) return v;
  return config.tenantExpensiveLimitPerHour;
}

// (old production-only check superseded by validateSecrets below)

// Secrets every operator has seen: the in-repo dev default and the
// .env.example placeholder. Booting with any of these outside dev/test
// would let anyone forge auth tokens or read stored OAuth keys.
export const KNOWN_PLACEHOLDER_SECRETS = new Set(
  [
    'dev-only-jwt-secret-change-me',
    'change_me_32_plus_random_hex',
    'change-me-to-a-random-32-char-string',
    'changeme',
    'change-me',
    'secret',
    'jwt-secret',
    'your-jwt-secret-here',
  ].map((s) => s.toLowerCase()),
);

export interface SecretsEnv {
  jwtSecret?: string;
  encryptionKey?: string;
  /** S-07: raw ENCRYPTION_KEYS value ("kid:hex,kid:hex,..."). */
  encryptionKeys?: string;
}

/**
 * Fail fast unless secrets are production-grade. Applies in ALL environments
 * except an explicit NODE_ENV=test|development, so a forgotten NODE_ENV or a
 * staging deploy can never ship with mock Stripe + a public JWT default.
 * Pure function (params, not process.env) so it is unit-testable.
 */
export function validateSecrets(nodeEnv: string, secrets: SecretsEnv): void {
  if (nodeEnv === 'test' || nodeEnv === 'development') return;
  const jwt = (secrets.jwtSecret ?? '').trim();
  if (jwt.length < 32) {
    throw new Error(
      `FATAL: JWT_SECRET must be at least 32 characters in ${nodeEnv} (got ${jwt.length}). ` +
        'Generate one with: openssl rand -hex 32',
    );
  }
  if (KNOWN_PLACEHOLDER_SECRETS.has(jwt.toLowerCase())) {
    throw new Error('FATAL: JWT_SECRET is a known placeholder value — set a real random secret');
  }
  const enc = (secrets.encryptionKey ?? '').trim();
  const encKeys = (secrets.encryptionKeys ?? '').trim();
  if (encKeys) {
    // S-07: versioned key set — every entry must be kid:32-byte-hex.
    const bad = encKeys.split(',').some((part) => {
      const idx = part.indexOf(':');
      return idx === -1 || !/^[A-Za-z0-9_-]{1,64}$/.test(part.slice(0, idx).trim()) || !/^[0-9a-fA-F]{64}$/.test(part.slice(idx + 1).trim());
    });
    if (bad) {
      throw new Error(
        `FATAL: ENCRYPTION_KEYS must be "kid:hex,kid:hex,..." with 32-byte hex keys in ${nodeEnv}.`,
      );
    }
  } else if (!/^[0-9a-fA-F]{64}$/.test(enc)) {
    throw new Error(
      `FATAL: ENCRYPTION_KEY must be a 32-byte hex string in ${nodeEnv}. Generate with: openssl rand -hex 32`,
    );
  }
}

// Fail fast at boot: the dev fallbacks above are publicly known values.
// Running outside dev/test without real secrets would let anyone forge
// auth tokens or decrypt stored OAuth/API keys.
validateSecrets(config.nodeEnv, {
  jwtSecret: process.env.JWT_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY,
  encryptionKeys: process.env.ENCRYPTION_KEYS,
});
