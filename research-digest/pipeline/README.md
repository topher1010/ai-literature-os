# Research Digest — Pipeline

Weekly literature triage. Polls PubMed (journal sweeps + keyword searches), bioRxiv, and NIH Reporter; embeds candidates against a research profile; scores top hits with Claude (Sonnet) for relevance and surprise; summarizes the survivors; writes to Supabase. The companion frontend reads from Supabase live — no redeploy needed for data updates.

## Architecture

```
Weekly cron run
  │
  ├── Step 1: poll-journals.js --commit --score
  │   ├── PubMed: configured keyword searches + journal sweeps
  │   ├── bioRxiv: last N days, keyword pre-filtered
  │   ├── Dedup against data/seen-pmids.json
  │   ├── Keyword-tier scoring (high/medium/low)
  │   └── Embed via OpenRouter + vector rank vs profile
  │
  ├── Step 2: score-with-claude.js papers
  │   ├── Reads $DIGEST_RUN_DIR/embedded-papers.json
  │   ├── Batches → claude -p (Sonnet) for relevance + surprise
  │   ├── Selection: relevance ≥ threshold; wildcards for surprise
  │   ├── Batched summarization
  │   ├── Upsert to Supabase digest_papers
  │   └── Commit staged seen-set → data/seen-pmids.json (only on success)
  │
  ├── Step 3: poll-grants.js --commit --score (NIH Reporter, same embed pipeline)
  └── Step 4: score-with-claude.js grants
        ├── Upsert to Supabase digest_grants
        └── Commit staged seen-set → data/seen-grants.json (only on success)
```

## Reliability features

- **Run-scoped artifacts.** Each run gets `runs/<YYYYMMDDTHHMMSS>/` containing `embedded-papers.json`, `embedded-grants.json`, `pending-seen-pmids.json`, `pending-seen-grants.json`, and `run-report.json`.
- **Seen-state on success only.** PMIDs/grants are marked seen in `data/seen-*.json` *only* after Supabase upsert returns success. A crash or abort leaves the run dir and the staged seen-set in place; the next run re-polls those candidates.
- **Fail-closed scoring.** `DIGEST_SCORING_ABORT_THRESHOLD_PCT` and `DIGEST_SUMMARY_ABORT_THRESHOLD_PCT` (default 50% each) abort the run *before* any Supabase write if per-batch failure rate exceeds the threshold.
- **Tests.** `npm test` runs `node --test scripts/*.test.js` — pure-function tests for `decideAbort()` and the `digest-run` lifecycle. No network, no API keys required, ~85ms.

## File layout

```
scripts/                  Node pipeline (no npm deps; built-in https only)
  poll-journals.js        PubMed + bioRxiv fetch, keyword scoring, embedding
  poll-grants.js          NIH Reporter fetch, same embedding pipeline
  score-papers.js         Embedding logic, prompts (loaded from prompts/), thresholds
  score-with-claude.js    LLM orchestration: claude -p scoring, Supabase upsert,
                          seen-set commit on success
  supabase-client.js      Supabase REST client, field mapping, batch upsert
  build-profile.js        Builds embedding profile vectors from seed PMIDs
  digest-run.js           Run-dir + pending-seen-set helpers
  summarize-papers.js     Standalone full-text summary generator
  process-summary-queue.js Processes summary requests from Supabase queue
  refetch-abstracts.js    One-off: re-fetch abstracts from PubMed
config/
  journals-config.example.json   PubMed searches + journal sweeps + keyword tiers
  grants-config.example.json     NIH Reporter searches + keyword tiers
prompts/                  Plain-text prompts loaded by score-with-claude.js, etc.
  scoring-prompt.example.txt
  summary-prompt.example.txt
  grant-scoring-prompt.example.txt
  grant-summary-prompt.example.txt
  full-summary-prompt.example.txt
data/                     Persistent state (gitignored when filled in)
  seed-pmids.example.json Seed list for embedding profile
embeddings/               Generated; gitignored
runs/<timestamp>/         Per-run artifacts; auto-pruned after 56 days
schema.sql                One-shot Supabase schema setup
```

## Setup

1. **Create a Supabase project.** Free tier is fine. Apply `schema.sql` via the SQL editor.
2. **Set env vars** in `~/.config/ai-literature-os.env`:

   ```
   SUPABASE_URL=https://xxx.supabase.co
   SUPABASE_SERVICE_KEY=eyJ...
   OPENROUTER_API_KEY=sk-or-v1-...
   ANTHROPIC_API_KEY=sk-ant-...
   UNPAYWALL_EMAIL=you@example.org
   DIGEST_SCORING_ABORT_THRESHOLD_PCT=50
   DIGEST_SUMMARY_ABORT_THRESHOLD_PCT=50
   ```

3. **Customize for your field.** Copy each `.example.json` / `.example.txt` to its non-example name and edit:

   ```bash
   cp config/journals-config.example.json config/journals-config.json
   cp config/grants-config.example.json config/grants-config.json
   for f in prompts/*.example.txt; do cp "$f" "${f%.example.txt}.txt"; done
   cp data/seed-pmids.example.json data/seed-pmids.json
   ```

   Then edit each file: drop in your search keywords, journal list, keyword tiers, scoring prompts (these are the most important — example calibration sentences should be replaced with examples from *your* field), and seed PMIDs.

4. **Build the embedding profile** (one-time):

   ```bash
   node scripts/build-profile.js
   ```

   This fetches abstracts for your seed PMIDs and writes `embeddings/profile.json`.

5. **Test a dry run:**

   ```bash
   node scripts/poll-journals.js
   node scripts/poll-grants.js
   ```

6. **Wire up cron.** A typical wrapper script orchestrates the whole pipeline. See [`../../cron/example-crontab`](../../cron/example-crontab) for a starting point.

## Run-report event types

`run-report.json` is appended to incrementally. `result` values:

| `result` | Meaning |
|---|---|
| `success` | Stage completed; all batches succeeded; Supabase upsert returned 2xx. |
| `partial` | Some scoring or summary batches failed but stayed under the abort threshold. Run continued and wrote to Supabase. `scoringFailed`/`summaryFailed` counts surface in the event. Worth investigating; not a data loss. |
| `abort` | Failure rate exceeded threshold. NO Supabase write. Seen-state stays uncommitted (next run re-polls these candidates). `reason` is `scoring_failure_rate` or `summary_failure_rate`; `thresholdPct` is recorded for diagnosis. |
| `no-grants-passed-threshold` | Grants stage only — scoring succeeded but no grant cleared the relevance bar. Seen-set still committed (we did observe these grants and chose to skip them). |
| `supabase-unconfigured` | Env vars missing. Exit non-zero, no commit. |

## Triage protocol after a run

```bash
ls -lt runs/ | head -3
cat runs/<latest>/run-report.json
```

Look for `"result": "success"` and `"seenCommitted": true` for both papers and grants stages. If either failed, the run folder remains for inspection and `data/seen-*.json` should be unchanged from its previous timestamp — the commit-on-success protection worked.

## Known limitations / pending work

- **Adaptive embedding profile** — the static profile in `embeddings/profile.json` is built once from your seed PMIDs. The `papers` library table accumulates ground-truth "papers actually saved." Periodic re-averaging from this data would personalize scoring further; not yet implemented.
- **`DIGEST_*_ABORT_THRESHOLD_PCT` defaults are permissive** (50%). Tighten after a few weeks of operation reveal what normal failure rates look like.
- **Library `papers.paper_id` format** — historical raw PMID/DOI vs slugified `digest_papers.paper_id`. Bridged in `api/feedback.js`; a future SQL `UPDATE` could backfill but isn't strictly necessary.
