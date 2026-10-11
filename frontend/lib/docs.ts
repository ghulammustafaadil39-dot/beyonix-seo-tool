/**
 * F-12 — help center content. Plain data + renderer; docs are reviewed
 * like code (see Q-04 docs-accuracy checks).
 */

export interface DocArticle {
  slug: string;
  title: string;
  description: string;
  updated: string;
  sections: Array<{ heading: string; body: string[] }>;
}

export const DOC_INDEX: Array<{ slug: string; title: string; description: string }> = [
  {
    slug: 'getting-started',
    title: 'Getting started',
    description: 'Add your site, verify ownership, and run your first audit in under 10 minutes.',
  },
  {
    slug: 'connecting-google',
    title: 'Connecting Search Console & Analytics',
    description: 'How the Google OAuth connection works, what permissions we ask for, and how to disconnect.',
  },
  {
    slug: 'methodology',
    title: 'How scores are computed',
    description: 'Exactly how the health score, keyword difficulty, and GEO score are calculated.',
  },
  {
    slug: 'keyword-research',
    title: 'Keyword research guide',
    description: 'Seed keywords, clustering by intent, difficulty, and finding quick wins.',
  },
  {
    slug: 'geo-guide',
    title: 'GEO: getting cited by AI assistants',
    description: 'How AI-visibility tracking works and what to do about it.',
  },
  {
    slug: 'glossary',
    title: 'SEO glossary',
    description: 'Plain-language definitions of every term we use in the product.',
  },
];

export const DOCS: Record<string, DocArticle> = {
  'getting-started': {
    slug: 'getting-started',
    title: 'Getting started',
    description: 'Add your site, verify ownership, and run your first audit in under 10 minutes.',
    updated: '2026-10-11',
    sections: [
      {
        heading: '1. Add your site',
        body: [
          'From the dashboard, click “Add site (guided)” and enter your domain (example.com — no https:// needed).',
          'You get a short onboarding checklist on the site page: verify → connect sources → first crawl → add keywords → first report.',
        ],
      },
      {
        heading: '2. Verify ownership',
        body: [
          'Pick a verification method: HTML meta tag, HTML file upload, or DNS TXT record. Follow the on-screen instructions, then click “Verify”.',
          'Verification proves you control the domain — we never crawl or connect data sources for unverified sites.',
        ],
      },
      {
        heading: '3. Connect Google (optional but recommended)',
        body: [
          'Connect Google Search Console to import your real keyword and click data, and Google Analytics for traffic stats.',
          'We use official Google APIs and only request the scopes we need. Disconnect anytime from the site page.',
        ],
      },
      {
        heading: '4. Run your first audit',
        body: [
          'Click “Run audit”. The crawler checks your pages for technical issues and computes a health score.',
          'Issues are ordered by impact and each one explains the fix in plain language.',
        ],
      },
      {
        heading: '5. Add keywords and schedule reports',
        body: [
          'Use keyword research to find terms your customers search for, then track them. Weekly reports summarize what changed.',
        ],
      },
    ],
  },
  'connecting-google': {
    slug: 'connecting-google',
    title: 'Connecting Search Console & Analytics',
    description: 'How the Google OAuth connection works, what permissions we ask for, and how to disconnect.',
    updated: '2026-10-11',
    sections: [
      {
        heading: 'What we request',
        body: [
          'Search Console: read-only access to your sites’ search performance data.',
          'Google Analytics: read-only access to reports for the property you choose.',
          'We never request write access, and we never see your Google password — the connection goes through Google’s official OAuth flow.',
        ],
      },
      {
        heading: 'Disconnecting',
        body: [
          'Disconnect Search Console or Analytics anytime from the site page. We delete the stored tokens immediately.',
          'You can also revoke access from your Google account security settings.',
        ],
      },
    ],
  },
  methodology: {
    slug: 'methodology',
    title: 'How scores are computed',
    description: 'Exactly how the health score, keyword difficulty, and GEO score are calculated.',
    updated: '2026-10-11',
    sections: [
      {
        heading: 'Site health score (0–100)',
        body: [
          'Each crawled issue has a severity (error, warning, info) and an impact weight. The score starts at 100 and subtracts weighted penalties per unique issue, normalized by the number of pages crawled.',
          'Fixing a high-impact error moves the score more than fixing a low-impact warning — the same order the audit list shows.',
        ],
      },
      {
        heading: 'Keyword difficulty (0–100)',
        body: [
          'Difficulty combines the authority of pages currently ranking for the keyword (estimated from backlink data) with SERP competition signals. Higher means harder to rank.',
          'Scores below 30 are quick wins for most small business sites; above 70 typically needs a sustained content and link effort.',
        ],
      },
      {
        heading: 'GEO score (0–100)',
        body: [
          'For each tracked prompt we ask multiple AI engines whether they mention your brand, cite your pages, and the sentiment of the mention.',
          'The score weights mentions, citations, and sentiment across engines. Improve it with structured data, entity pages, and an llms.txt file — the GEO tab lists concrete actions.',
        ],
      },
    ],
  },
  'keyword-research': {
    slug: 'keyword-research',
    title: 'Keyword research guide',
    description: 'Seed keywords, clustering by intent, difficulty, and finding quick wins.',
    updated: '2026-10-11',
    sections: [
      {
        heading: 'Start with seeds',
        body: [
          'Enter 2–5 words that describe what you sell (“accounting software”, “plumber austin”). We expand them into related keywords with real search volume.',
        ],
      },
      {
        heading: 'Read difficulty and intent',
        body: [
          'Difficulty (0–100) estimates how hard ranking is. Intent (informational, commercial, transactional, navigational) tells you what the searcher wants — match your page to the intent.',
          'Sort by “quick wins”: decent volume, low difficulty, transactional intent.',
        ],
      },
      {
        heading: 'Cluster by topic',
        body: [
          'Keywords are grouped by topic so one strong page can rank for a whole cluster. Watch for cannibalization — two of your pages competing for the same keyword — and merge or differentiate them.',
        ],
      },
    ],
  },
  'geo-guide': {
    slug: 'geo-guide',
    title: 'GEO: getting cited by AI assistants',
    description: 'How AI-visibility tracking works and what to do about it.',
    updated: '2026-10-11',
    sections: [
      {
        heading: 'What we track',
        body: [
          'For prompts your customers actually ask, we check whether ChatGPT, Perplexity, Gemini, Claude, and Google AI Overviews mention your brand, cite your pages, and how they talk about you.',
          'Share of voice compares your citation rate against competitors for the same prompts.',
        ],
      },
      {
        heading: 'How to improve',
        body: [
          'Publish clear, factual entity pages (who you are, what you do, where). Add schema markup. Publish an llms.txt file that points AI crawlers at your best content.',
          'The GEO tab turns this into a checklist per site — do the quick wins first.',
        ],
      },
    ],
  },
  glossary: {
    slug: 'glossary',
    title: 'SEO glossary',
    description: 'Plain-language definitions of every term we use in the product.',
    updated: '2026-10-11',
    sections: [
      {
        heading: 'Terms',
        body: [
          'Crawl — our bot visiting your pages to find issues, like Google does.',
          'SERP — the search engine results page; where you rank.',
          'Intent — what the searcher wants: to learn (informational), compare (commercial), or buy (transactional).',
          'Cannibalization — two of your pages competing for the same keyword, splitting your ranking power.',
          'GEO — Generative Engine Optimization: being mentioned and cited by AI assistants.',
          'Share of voice — your visibility compared to competitors for the same keywords or prompts.',
          'Backlink — a link from another site to yours; new/lost links change over time.',
          'Anchor text — the clickable words of a link.',
        ],
      },
    ],
  },
};
