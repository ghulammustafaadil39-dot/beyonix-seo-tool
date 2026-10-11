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
  jwtSecret: opt('JWT_SECRET', 'dev-only-jwt-secret-change-me'),
  // Local signing secret for the mock Stripe webhook (dev/test only).
  // Mock webhooks are rejected when this is unset, and always in production.
  mockWebhookSecret: opt('MOCK_WEBHOOK_SECRET', ''),
  appUrl: opt('APP_URL', 'http://localhost:3000').replace(/\/$/, ''),
  apiUrl: opt('API_URL', 'http://localhost:4000').replace(/\/$/, ''),
  encryptionKey: opt('ENCRYPTION_KEY', ''),

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
  if (!/^[0-9a-fA-F]{64}$/.test(enc)) {
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
});
