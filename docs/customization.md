# Customization

The repo is opinionated about one researcher's workflow. Adapting it to yours mostly means editing a small set of configuration points — most of them in gitignored files (`prompts/*.txt`, `config/*.json`, `data/seed-pmids.json`, `scientific-identity.md`) so your private versions never accidentally land in a fork.

## Required customizations (won't work without these)

| File | What to change |
|---|---|
| `.env` | All path variables, all API keys, your `RESEARCHER_PROFILE` one-liner |
| `research-digest/pipeline/config/journals-config.example.json` → `journals-config.json` | Search queries + journal sweeps + keyword tiers for paper polling |
| `research-digest/pipeline/config/grants-config.example.json` → `grants-config.json` | NIH institute filter, mechanism filter, search queries |
| `research-digest/pipeline/prompts/*.example.txt` → `*.txt` (5 files) | Researcher-profile-specific scoring + summary prompts |
| `research-digest/pipeline/data/seed-pmids.example.json` → `seed-pmids.json` | The 50–100 seed papers used to build your three profile embeddings (Core / Methods / Adjacent) |
| `templates/scientific-identity-template.md` → your own `scientific-identity.md` (uncommitted) | Your role, lab, current grants, key terms, preferred journals, collaboration style |

## Strongly recommended customizations

| File | What to change |
|---|---|
| `claude-code-agents/vault-librarian.md` | The cluster-quality observations and threshold tuning notes. The shipped version is generic. |
| `cron/example-crontab` | Schedules. Defaults are conservative; tighten to your timezone and run-frequency preferences. |
| `research-digest/frontend/app.js`, `library.js`, `grants.js` | Replace `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` placeholder strings before deploying. |

## Optional customizations

| File | What to change |
|---|---|
| `vault-pipeline/scripts/qmd-openrouter.sh` | Embedding model name. Default `google/gemini-embedding-2-preview`. **If you change this, also re-tune `relate-papers.sh`'s `MIN_SCORE`** and re-embed everything that shares the vector space. |
| `vault-pipeline/scripts/relate-papers.sh` | `MIN_SCORE` neighbor threshold. Default 0.83 is calibrated for the current model. |
| `vault-pipeline/scripts/cluster-vault-graph.py` | Leiden parameters (k, resolution). Defaults give ~50 communities on a ~1,200-paper vault; expect different numbers at different vault sizes. |
| `claude-code-skills/*/SKILL.md` | Any of the skill instructions. The shipped versions reflect one researcher's conventions. |
| `research-digest/frontend/` | UI, design tokens, branding (titles, headers, footer). The shipped version uses generic "Research Digest" copy — adapt to your project name. |

## What NOT to customize without thinking carefully

- **The Pipeline Contract** in `ARCHITECTURE.md`. The seven invariants exist because past violations cost money. Read the rationale before relaxing one.
- **The 4-tier reading protocol.** Each tier has a cost reason. Skipping straight to tier 4 (full paper into main session) burns context and money.
- **The QMD patches.** The OpenRouter transport patch makes embedding **fail loudly** when the API is unreachable. Reverting that means silent fallback to local embeddinggemma — which gives the wrong vectors for your vault. The vec0 patch fixes a UNIQUE constraint crash on re-embed; reverting it crashes the pipeline.
- **The `integrate-paper.sh` design.** The LLM is invoked without file-write tools and emits JSON; the shell script parses it and patches the targeted paper's frontmatter. Don't give the LLM file-write access — it will eventually write something wrong to the wrong paper, and you won't know which one it broke.

## Customization checklist (for a fresh adoption)

Before your first real run:

- [ ] `.env` filled in (all required vars)
- [ ] `RESEARCHER_PROFILE` set to a one-sentence description of you
- [ ] `scientific-identity.md` written (and gitignored)
- [ ] (If using digest) `journals-config.json` and `grants-config.json` reflect your field
- [ ] (If using digest) Five `prompts/*.txt` files customized with your researcher profile
- [ ] (If using digest) `seed-pmids.json` populated with your representative papers (Core / Methods / Adjacent buckets)
- [ ] (If using digest) Supabase project created, schema applied from `research-digest/pipeline/schema.sql`
- [ ] (If using digest) `build-profile.js` run once to seed `embeddings/profile.json`
- [ ] (If using digest) Vercel deploy of `research-digest/frontend/`, env vars set, Supabase placeholders replaced in browser JS
- [ ] Cron entries enabled for the schedules you want

After the first week of real runs:

- [ ] Skim the vault-librarian's first health report
- [ ] Adjust `DIGEST_SCORING_ABORT_THRESHOLD_PCT` if the default 50% is too loose for your error rate
- [ ] Check whether the topic clusters make sense; if not, adjust Leiden resolution
