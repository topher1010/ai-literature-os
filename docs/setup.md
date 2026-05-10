# Setup

End-to-end installation guide. Plan ~90 minutes for first-time setup, plus build time for the initial vault embedding (proportional to vault size).

> **Prereq check.** This guide assumes Linux or macOS, a working terminal, basic command-line comfort, and that you can install system packages on your machine. If any of those isn't true, this is not the right repo for you.

## What you need

| Tool | Why | Install |
|---|---|---|
| Python ≥3.11 | Pipeline scripts + Docling + PaperQA2 | `apt install python3 python3-venv` / `brew install python` |
| [Bun](https://bun.sh) | Runtime for QMD | `curl -fsSL https://bun.sh/install \| bash` |
| `pdftotext` | PDF fallback parser | `apt install poppler-utils` / `brew install poppler` |
| `pandoc` | DOCX conversion (only if you have DOCX inputs) | `apt install pandoc` / `brew install pandoc` |
| `curl` | bioRxiv HTML scraping fallback | preinstalled on most systems |
| [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) | LLM tagging, summary generation, agent skills | follow Anthropic's install guide |
| [OpenRouter](https://openrouter.ai) account | Embeddings (3072-dim Gemini); ~$10 credit gets you started | sign up + create API key |
| Anthropic API key (or Claude Code subscription) | LLM steps | `console.anthropic.com` |

Optional, for the research digest:

- [Supabase](https://supabase.com) free-tier project for paper storage
- [Vercel](https://vercel.com) free-tier deploy for the frontend

## Step 1 — Clone and inspect

```bash
# Pick a stable location. Subsequent steps refer to this path as $REPO.
git clone https://github.com/topher1010/ai-literature-os.git ~/Projects/ai-literature-os
cd ~/Projects/ai-literature-os
export REPO="$PWD"
```

Read [`ARCHITECTURE.md`](../ARCHITECTURE.md). Don't skip — the Pipeline Contract has hard invariants.

> **Path convention.** The remaining steps use `$REPO` for the clone location. If your clone lives somewhere else, set `REPO` accordingly and the rest of the guide works unchanged.

## Step 2 — Configure environment

```bash
cp .env.example ~/.config/ai-literature-os.env
$EDITOR ~/.config/ai-literature-os.env
```

Fill in at minimum:

```
VAULT_DIR=$HOME/literature-os/vault
SOURCE_DIR=$HOME/literature-os/sources
NAV_DIR=$HOME/literature-os/nav
OPENROUTER_API_KEY=sk-or-v1-...
ANTHROPIC_API_KEY=sk-ant-...
```

Then create the directories:

```bash
mkdir -p ~/literature-os/{vault,sources,nav,sources/manual}
```

## Step 3 — Install QMD with the patches

QMD must be pinned to a specific commit and patched. See [`vault-pipeline/qmd-patches/README.md`](../vault-pipeline/qmd-patches/README.md) for the rationale; the commands below summarize.

```bash
# Clone QMD at the tested commit
git clone https://github.com/tobi/qmd.git ~/code/qmd
cd ~/code/qmd
git checkout 96634da

# Apply the patches
cp $REPO/vault-pipeline/qmd-patches/llm.ts.patched src/llm.ts
cp $REPO/vault-pipeline/qmd-patches/store.ts.patched src/store.ts

# Build / install via Bun (per QMD's own README)
bun install
bun link  # makes `qmd` available on PATH
```

Verify:

```bash
qmd --version
```

## Step 4 — Create the Python venv and install dependencies

```bash
python3 -m venv ~/.venvs/ai-literature-os
source ~/.venvs/ai-literature-os/bin/activate
pip install -r $REPO/vault-pipeline/requirements.txt
```

Pipeline scripts source the env file at run time, but if you want to run scripts manually outside cron, source it in your shell:

```bash
echo 'source ~/.config/ai-literature-os.env' >> ~/.bashrc  # or .zshrc
```

## Step 5 — Tiny demo path (verify the install)

Add 3 well-cited open-access PMIDs to a test vault. This exercises the full intake → enrichment → embedding → search loop in about five minutes.

```bash
source ~/.config/ai-literature-os.env  # if not already sourced
cd $REPO/vault-pipeline/scripts

# Three landmark open-access papers (substitute your own if you want).
# These should all return PMC full text.
./add-paper.py 26196891 28489685 24013207

# Then run the integration + index pipeline
./integrate-paper.sh --batch 3
./qmd-openrouter.sh update
./qmd-openrouter.sh embed --collection science
./relate-papers.sh
./cluster-vault-graph.py full-run --resolution 4.0 --percentile 60
./generate-index.py
```

Verify success:

```bash
ls "$VAULT_DIR"      # should show 3 .md files
ls "$NAV_DIR"        # should show _index.md, _topic-*.md, _related-papers.json

# Search with QMD
./qmd-openrouter.sh vsearch "your search term" -c science
```

If all four steps produced output, the install works.

## Step 6 — Real vault

Three intake paths. Pick whichever fits how you already work:

### A — PMID list (RIS or text file)

```bash
# From an Endnote XML export, extract PMIDs
./parse-endnote.py /path/to/library.xml

# Then ingest the new PMIDs
./add-paper.py --file /tmp/endnote_pmids.txt --batch-size 50
```

### B — Direct PMID intake

```bash
./add-paper.py 12345678 87654321 11223344
```

### C — PDF source folder

Drop PDFs into `$SOURCE_DIR/`. Then run:

```bash
./sync-vault.sh
```

The first run on a real vault will be slow (proportional to paper count + your network bandwidth for PMC fetches and embedding API calls). Subsequent runs are incremental.

## Step 7 — Wire up cron

See [`cron/example-crontab`](../cron/example-crontab). Typical schedule:

```cron
# Nightly vault sync at midnight CT
0 0 * * * /home/you/Projects/ai-literature-os/vault-pipeline/scripts/sync-vault.sh
```

Edit your crontab (`crontab -e`) and uncomment what you want. **Critical:** if you have other QMD collections, they must re-embed *after* the vault sync — see Pipeline Contract item 5.

## Step 8 — Optional: Claude Code skills + librarian agent

If you use [Claude Code](https://docs.claude.com/en/docs/claude-code), the three skills and the vault-librarian agent give you `/science-search`, `/deep-synthesis`, `/add-papers`, plus a Tue/Fri health-check agent. Install:

```bash
mkdir -p ~/.claude/skills ~/.claude/agents
cp -r claude-code-skills/* ~/.claude/skills/
cp claude-code-agents/vault-librarian.md ~/.claude/agents/
```

## Step 9 — Scientific identity (any agent)

This is not a skill — it's a context file the agent loads at the start of a science session so it knows who it's working with (your role, lab, current grants, key terms, preferred journals). Useful regardless of which agent you use.

```bash
cp templates/scientific-identity-template.md scientific-identity.md
$EDITOR scientific-identity.md
```

Then load `scientific-identity.md` into your agent however your tool supports (Claude Code: drop it in the project context; other tools: their equivalent). The filled-in file is gitignored so your version stays local.

## Step 10 — Optional: Research digest

The research digest is a weekly literature triage system: polls PubMed + bioRxiv + NIH Reporter, scores results against your researcher profile, stores in Supabase, serves a Vercel frontend for triage and library management. **Optional** — the vault pipeline above works without it.

Setup is in two parts; each component has its own README:

- [`research-digest/pipeline/README.md`](../research-digest/pipeline/README.md) — schema apply, config + prompt template setup, profile build, cron entries
- [`research-digest/frontend/README.md`](../research-digest/frontend/README.md) — Vercel deploy, env vars, API routes

Quick reference:

```bash
# 1. Database — apply the schema in your Supabase SQL editor:
cat $REPO/research-digest/pipeline/schema.sql

# 2. Pipeline config — copy templates to active versions (.txt, .json) and edit:
cd $REPO/research-digest/pipeline/config && \
  cp journals-config.example.json journals-config.json && \
  cp grants-config.example.json    grants-config.json
cd $REPO/research-digest/pipeline/prompts && \
  for f in *.example.txt; do cp "$f" "${f%.example.txt}.txt"; done
cd $REPO/research-digest/pipeline/data && \
  cp seed-pmids.example.json seed-pmids.json   # then edit with your seeds

# 3. Build the profile (one-time):
node $REPO/research-digest/pipeline/scripts/build-profile.js

# 4. Frontend — replace YOUR_SUPABASE_URL / YOUR_SUPABASE_ANON_KEY placeholders
#    in app.js, library.js, grants.js. Then deploy to Vercel and set
#    SUPABASE_URL, SUPABASE_SERVICE_KEY, DIGEST_ADMIN_PASSWORD env vars.
```

## Troubleshooting first-run problems

- **`qmd: command not found`** — `bun link` didn't add it to PATH. Try `~/.bun/bin/qmd --version`.
- **`OPENROUTER_API_KEY not set`** — your shell didn't pick up the env file. Source it (`source ~/.config/ai-literature-os.env`) and re-run.
- **`add-paper.py` reports `BioRxiv API error`** — known issue: `api.biorxiv.org` returns "Not available" for many papers. The script falls back to HTML scraping via curl. If curl is also failing, check whether your network is blocking biorxiv.org.
- **`qmd embed` errors with `SQLITE_CONSTRAINT_UNIQUE`** — duplicate source files in the vault. Run `check-duplicates.py --auto-resolve` first; do NOT `qmd cleanup` as a first resort (it destroys the embedding cache).
- **Cluster generation produces a single huge cluster** — your vault is too small for Leiden to find structure (usually <30 papers), or your `--resolution` is too low. Try `--resolution 8.0` or wait until you have more papers.
- **Embedding cost spike** — Pipeline Contract violation. Find the script that's writing to paper YAML repeatedly. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) Recovery section.

## Setup notes

Setup is intentionally hands-on. The system has real moving parts and a one-command installer would hide them — running through the install yourself is the fastest way to learn where the seams are when you adapt it.
