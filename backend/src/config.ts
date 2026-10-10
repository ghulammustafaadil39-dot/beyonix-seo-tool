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
  nodeEnv: opt('NODE_ENV', 'development'),
  port: parseInt(opt('PORT', '4000'), 10),
  databaseUrl: opt('DATABASE_URL', 'postgres://bseo:bseo@localhost:5432/bseo'),
  redisUrl: opt('REDIS_URL', 'redis://localhost:6379'),
  jwtSecret: opt('JWT_SECRET', 'dev-only-jwt-secret-change-me'),
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

// Fail fast in production: the dev fallbacks below are publicly known values.
// Running prod without real secrets would let anyone forge auth tokens.
if (config.nodeEnv === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-only-jwt-secret-change-me') {
    throw new Error('FATAL: JWT_SECRET must be set to a random 32+ char value in production');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY ?? '')) {
    throw new Error('FATAL: ENCRYPTION_KEY must be a 32-byte hex string in production');
  }
}
