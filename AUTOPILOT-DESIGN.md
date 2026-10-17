# Beyonix SEO Autopilot — Design (v2.0)

**Vision (Mustafa, Oct 17):** Jo kaam ek SEO team karti hai, wo sab product kare.
Non-tech small business owner sirf website connect kare — uske baad uski SEO
khud hoti rahe. Sirf reporting/auditing nahi — asal kaam.

## Two Modes

### 1. Co-pilot (approval mode) — default
- Tool website audit karta hai
- Fix ka plan banata hai: "ye 12 titles theek karunga, ye 5 meta descriptions, ye 3 broken links"
- User ko simple list dikhata hai: kya change hoga, kyun
- User **Approve** dabata hai → tool khud website pe changes karta hai
- Har change ka log + one-click undo

### 2. Autopilot (full-auto mode)
- Koi approval nahi — tool khud audit kare, khud fix kare
- User ko sirf weekly summary: "is hafte 23 fixes, 2 blog posts publish, ranking +4"
- Koi bhi waqt mode switch kar sakta hai

## Website se connection kaise? (sab se important sawal)

Tool ko website **badalne** ke liye access chahiye. Phase-wise:

### Phase 1: WordPress (sab se pehle)
- Duniya ki ~40% websites WordPress pe hain, small business ka standard
- **Application Passwords** se connect — koi plugin install nahi karna, secure
- Tool kar sakta hai: post/page titles, meta descriptions (SEO plugin via),
  headings, alt text, internal links, naye blog posts publish, redirects

### Phase 2: Webflow, Shopify, Wix
- Har ek ka official API hai

### Phase 3: Custom websites
- Fix ka code export (user/developer lagaye) — full auto possible nahi

## Kya kya automate hoga

| Kaam | Co-pilot | Autopilot |
|------|----------|-----------|
| Titles/meta fix | approve ke baad | khud |
| Broken links fix | approve ke baad | khud |
| Image alt text | approve ke baad | khud |
| Blog post likhna + publish | approve ke baad | khud |
| Internal linking | approve ke baad | khud |
| Rank tracking + alerts | auto | auto |
| Weekly report | auto | auto |
| Backlink outreach | draft banaye, user bheje | draft banaye, user bheje |

*Backlink outreach poori auto nahi — doosri websites ko email jata hai,
is me human review zaroori hai (spam risk).*

## Safety (trust ke liye zaroori)

1. **Har change se pehle backup** — WordPress revisions automatic hain
2. **Change log** — kya badla, kab, kyun — sab record
3. **One-click undo** — kuch galat lage to wapas
4. **Kabhi delete nahi** — tool sirf improve karta hai, content delete nahi karta
5. **Rate limits** — ek din me max N changes (default 20), taake kuch galat
   ho to nuksan limited ho

## User ka safar (non-tech)

1. Signup → "Apni website connect karein"
2. WordPress URL + username + application password dalein (2-minute guide)
3. Mode chunein: "Khud karo" (autopilot) ya "Pehle mujh se poocho" (co-pilot)
4. Bas. Uske baad weekly email: "aapki SEO ki progress"

## Technical plan

- **Naya module:** `backend/src/services/autopilot/` — fix engine
- **WordPress client:** `backend/src/providers/wordpress.ts` — REST API wrapper
- **Approval flow:** `backend/src/routes/autopilot.ts` — propose/approve/execute
- **Change log:** nayi DB table `site_changes` (kya, kab, purani value, nayi value)
- **Frontend:** dashboard me "Autopilot" tab — mode switch, pending approvals,
  change history, undo button

## Kya nahi hoga (honest limits)

- Custom-coded websites pe full auto nahi (sirf fix export)
- Backlink outreach me human review zaroori
- Google penalty wale shortcuts nahi (keyword stuffing, link schemes) — sirf
  white-hat SEO
