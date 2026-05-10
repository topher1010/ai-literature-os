# Research Digest — Frontend

Static HTML/CSS/JS site with Vercel serverless API routes. Reads from Supabase live; the [pipeline](../pipeline/) (cron job) writes to Supabase. No build step.

Three pages:

- **`index.html`** (`/`) — Curated papers, batched by week. Admin can save selected papers to the library and dismiss processed batches.
- **`grants.html`** (`/grants`) — NIH-funded grants relevant to your research, filterable by mechanism (R01, R21, P01, K, U).
- **`library.html`** (`/library`) — Saved papers waiting to be vaulted, summarized, or marked done. Admin-only triage actions.

## Setup

1. **Apply the schema.** Set up the four Supabase tables (`digest_papers`, `digest_grants`, `papers`, `feedback_events`) using [`../pipeline/schema.sql`](../pipeline/schema.sql).
2. **Substitute Supabase credentials** in `app.js`, `library.js`, and `grants.js`. Replace the placeholder strings:
   ```js
   const SUPABASE_URL = 'YOUR_SUPABASE_URL';
   const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
   ```
   with your project's URL and publishable anon key. The anon key is safe to ship in browser code (RLS-protected); the service-role key is NOT and lives only in Vercel env vars.
3. **Deploy to Vercel.** Connect the repo, set environment variables (next section), deploy.

## Vercel environment variables

Set these in your Vercel project's Settings → Environment Variables:

| Variable | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL` | `api/_lib/supabase.js` | Same URL as the in-browser constant. |
| `SUPABASE_SERVICE_KEY` | API routes | Service-role key for server-side writes (saves, deletes, status updates). |
| `DIGEST_ADMIN_PASSWORD` | `api/login.js` | Plaintext password used to derive HMAC auth tokens. Pick a long random string. |

## Architecture

```
Browser (anon read) ─→ Supabase REST API
        │                ↑
        ↓                │
  /api/* routes  ───→ Supabase REST API (service-key writes)
  (Vercel serverless)

  /api/login           — POST: validates DIGEST_ADMIN_PASSWORD, sets HMAC cookie
  /api/logout          — POST: clears auth cookies
  /api/feedback        — POST: copies selected digest_papers rows into papers
  /api/update-paper    — POST: patches paper status (vault, summary, done)
  /api/remove          — POST: deletes papers from Supabase
```

Reads use the publishable anon key (RLS-protected). Writes use the service role key, available only to API routes.

### Shared API helpers

`api/_lib/auth.js` provides `makeToken`, `parseCookies`, and `requireAdmin` (constant-time HMAC compare via `crypto.timingSafeEqual`). `api/_lib/supabase.js` provides `supabaseRequest`, `quoteId`, `inFilter`, and `eqFilter`. The `_lib/` prefix excludes these from Vercel's serverless function build — they're importable from sibling routes but not exposed as endpoints.

### Sanitization

`lib/sanitize.js` is a strict allowlist HTML sanitizer (UMD-wrapped: works as CommonJS for tests, browser global for `library.js`). The `papers.full_text_summary` column holds rendered HTML produced by the pipeline; `library.js` runs it through `sanitize()` before injecting into the DOM. Allowed tags: `<h4>`, `<p>`, `<ul>`, `<li>`. All attributes are stripped. Defense-in-depth — the pipeline already escapes inner text at generation, but a strict client-side sanitizer means even a pipeline regression can't enable XSS.

## Tests

```bash
npm test   # node --test api/_lib/*.test.js lib/*.test.js
```

Pure-function tests for `auth.js` (HMAC constant-time compare, cookie parsing), `supabase.js` (PostgREST filter encoding), and `sanitize.js` (allowlist + XSS-evasion patterns). ~35 tests, no network, run in ~85ms.

## Design notes

The implementation lives in `style.css` (no Tailwind, no framework). Key principles:

- **Fonts**: Newsreader serif for hero subtitle + paper titles only. Inter sans for everything else.
- **Palette**: Slate/zinc neutrals with warm oatmeal accents.
- **Layout**: Flat — no card boxes. Papers separated by ghost-border dividers. Max-width 960px.
- **Score pills**: Blue for Relevance, purple for Surprise.

## Customization

- **Site title / brand text**: edit the `<title>`, `header-brand`, and `<footer>` text in the three HTML files.
- **Hero copy**: edit `<h1 class="hero-subtitle">` and `<p class="hero-description">` in each HTML file for your audience.
- **Color tokens**: edit `style.css` (top-of-file CSS custom properties).
- **API behavior**: action map in `api/update-paper.js` defines what "Vault", "Request Summary", and "Mark Done" do at the database level.
