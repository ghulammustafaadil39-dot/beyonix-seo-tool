# Google Search Console — Setup Guide

Connect real Google Search Console to unlock **free** keyword and backlink data
(real search queries, impressions, positions, linking sites). No paid API needed.

## Step 1: Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. Note the project name — you'll need it below

## Step 2: Enable the Search Console API

1. In the Cloud Console, go to **APIs & Services → Library**
2. Search for **"Google Search Console API"**
3. Click **Enable**

## Step 3: OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Choose **External** (unless you have a Google Workspace org)
3. Fill in: app name (e.g. "Beyonix SEO Tool"), your email, developer email
4. Scopes: add these two:
   - `https://www.googleapis.com/auth/webmasters.readonly`
   - `https://www.googleapis.com/auth/analytics.readonly`
5. Add your email as a **test user** (required while the app is in testing mode)
6. Save

## Step 4: Create OAuth Credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name: "Beyonix SEO Tool"
5. **Authorized redirect URIs** — add:
   - `http://localhost:4000/api/v1/gsc/callback` (for local dev)
   - `https://YOUR-DOMAIN/api/v1/gsc/callback` (for production — replace YOUR-DOMAIN)
6. Click **Create** — copy the **Client ID** and **Client Secret**

## Step 5: Add to .env

```bash
GOOGLE_CLIENT_ID=your-client-id-here
GOOGLE_CLIENT_SECRET=your-client-secret-here
# Optional: override the redirect URI if different from default
# GOOGLE_REDIRECT_URI=https://YOUR-DOMAIN/api/v1/gsc/callback
```

Then rebuild the API container:

```bash
docker compose up -d --build api
```

## Step 6: Connect in the UI

1. Open your site in the dashboard
2. Go to **Keywords** or **Backlinks** tab
3. Click **Connect Google Search Console**
4. Sign in with the Google account that owns the Search Console property
5. Approve the requested (read-only) permissions

Done — keyword suggestions and backlink data now come from **real** GSC.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Mock Google data" warning in logs | `GOOGLE_CLIENT_ID`/`SECRET` not set — complete Step 5 |
| OAuth error `redirect_uri_mismatch` | The redirect URI in Step 4 must match exactly (including http/https and path) |
| "Access blocked" during consent | Add your email as a test user (Step 3.5) |
| No queries returned | New sites need a few days of GSC data; the property must be verified in Search Console |
| Token expired | Reconnect via the UI — refresh tokens are stored encrypted |

## What data we use (read-only)

- **Search queries**: query text, clicks, impressions, average position (last 28 days)
- Used for: keyword suggestions (opportunity queries), backlink insights
- We never modify anything in your Google account.
