# `research-digest/`

Optional weekly literature triage system. Polls PubMed, bioRxiv, and NIH Reporter for relevant papers and grants; scores them via Claude Sonnet against a research profile you build from seed papers; stores results in Supabase; serves a Vercel-deployed frontend for browsing, saving, and full-text summarization.

The whole system is **optional** — the vault pipeline (in `vault-pipeline/`) works without it. The digest exists for the case where you want a curated weekly feed of new literature on top of your local vault.

## Components

```
research-digest/
├── pipeline/   — Cron job (Node, no deps): polls + scores + writes to Supabase
└── frontend/   — Static site + Vercel API routes: reads from Supabase
```

Each component has its own README:

- [`pipeline/README.md`](pipeline/README.md) — architecture, setup, run-report event types
- [`frontend/README.md`](frontend/README.md) — Vercel deploy, API routes, design system

## What you need to run this

- A [Supabase](https://supabase.com) project (free tier is fine)
- A [Vercel](https://vercel.com) deploy of `frontend/` (free tier is fine)
- An OpenRouter account for embeddings
- An Anthropic API key (or Claude Code subscription) for scoring + summarization
- A weekly cron entry pointing at `pipeline/` — see [`../cron/example-crontab`](../cron/example-crontab)

## Setup quick reference

1. **Database**: apply [`pipeline/schema.sql`](pipeline/schema.sql) to a fresh Supabase project. Set RLS policies as documented at the bottom of that file.
2. **Pipeline config** (in `pipeline/`):
   ```bash
   cd config && cp journals-config.example.json journals-config.json
   cd config && cp grants-config.example.json    grants-config.json
   cd prompts && for f in *.example.txt; do cp "$f" "${f%.example.txt}.txt"; done
   cd data    && cp seed-pmids.example.json seed-pmids.json
   ```
   Edit each for your field (search keywords, journal list, scoring prompt calibration examples, seed PMIDs).
3. **Build the profile**: `node pipeline/scripts/build-profile.js` (one-time).
4. **Frontend**: replace `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` placeholders in `frontend/app.js`, `library.js`, `grants.js`. Deploy to Vercel; set `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `DIGEST_ADMIN_PASSWORD` in the project's environment variables.
5. **Cron**: schedule `pipeline/scripts/poll-journals.js --commit --score` and `poll-grants.js --commit --score` followed by `score-with-claude.js papers` and `score-with-claude.js grants` to run weekly.

## Reliability features

- **Run-scoped artifacts.** Each run writes to `pipeline/runs/<timestamp>/` instead of fixed `/tmp` paths.
- **Seen-state on success only.** PMIDs marked seen only after Supabase upsert succeeds. Aborted runs leave dedup state untouched, so the next cron retries.
- **Fail-closed scoring.** `DIGEST_SCORING_ABORT_THRESHOLD_PCT` and `DIGEST_SUMMARY_ABORT_THRESHOLD_PCT` (default 50%) abort the run *before* any Supabase write if failure rate exceeds the threshold.
- **HTML sanitization.** `frontend/lib/sanitize.js` strict allowlist sanitizer applied to `full_text_summary` before injection — defense-in-depth on top of pipeline-side escaping.
- **Tests.** `npm test` in either `pipeline/` or `frontend/` runs node:test pure-function tests in <100ms. Covers: threshold logic, seen-state lifecycle, PostgREST filter encoding, HMAC constant-time compare, sanitizer XSS resistance.

## When to skip this entirely

If your literature triage already works (Endnote alerts, Google Scholar, RSS, etc.) and you don't need a curated weekly digest, you can ignore this directory. The vault pipeline (`../vault-pipeline/`) is the load-bearing part of the repo; this is a downstream extension.

The vault-librarian agent (`../claude-code-agents/vault-librarian.md`) has an optional Section 8 that audits research digest run-reports — that section runs only if you've wired up the digest. Skip-friendly.
