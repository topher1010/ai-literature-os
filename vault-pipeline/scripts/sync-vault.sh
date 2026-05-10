#!/usr/bin/env bash
# sync-vault.sh — Top-level nightly pipeline orchestrator.
#
# Chains all the vault-pipeline steps: convert new source files → dedup →
# enrich → upgrade → integrate → re-embed → relate → cluster → re-index
# PaperQA2.
#
# Run from cron (see ../cron/example-crontab) or manually:
#
#   sync-vault.sh                  # Normal run
#   sync-vault.sh --dry-run        # Preview only
#   sync-vault.sh --skip-integrate # Skip Claude-CLI steps (LLM enrichment + integration + summary)
#   sync-vault.sh --skip-pqa       # Skip PaperQA2 index rebuild
#
# Required env: VAULT_DIR, OPENROUTER_API_KEY, ANTHROPIC_API_KEY.

set -uo pipefail
# (no -e: we want individual step failures to log and continue)

ENV_FILE="${ENV_FILE:-$HOME/.config/ai-literature-os.env}"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"

: "${VAULT_DIR:?VAULT_DIR not set; configure in $ENV_FILE}"

LOG_DIR="${LOG_DIR:-/tmp}"
LOGFILE="$LOG_DIR/sync-vault.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PYTHON="${VENV_PYTHON:-$HOME/.venvs/ai-literature-os/bin/python}"

CONVERTER="$SCRIPT_DIR/convert-vault.py"
DEDUP_CHECK="$SCRIPT_DIR/check-duplicates.py"
ENRICH_PAPER="$SCRIPT_DIR/enrich-paper.py"
ENRICH_LLM="$SCRIPT_DIR/enrich-llm.py"
UPGRADE_STUBS="$SCRIPT_DIR/upgrade-stubs.py"
UPGRADE_PREPRINTS="$SCRIPT_DIR/upgrade-preprints.py"
GENERATE_SUMMARY="$SCRIPT_DIR/generate-summary.py"
INTEGRATE_PAPER="$SCRIPT_DIR/integrate-paper.sh"
GENERATE_INDEX="$SCRIPT_DIR/generate-index.py"
CLUSTER_GRAPH="$SCRIPT_DIR/cluster-vault-graph.py"
RELATE_PAPERS="$SCRIPT_DIR/relate-papers.sh"
PQA_INDEX="$SCRIPT_DIR/paperqa-index.py"
QMD_WRAPPER="$SCRIPT_DIR/qmd-openrouter.sh"

if [[ ! -x "$VENV_PYTHON" ]]; then
    echo "ERROR: venv python not found at $VENV_PYTHON" >&2
    echo "Set VENV_PYTHON in $ENV_FILE or create the venv per docs/setup.md" >&2
    exit 1
fi

mkdir -p "$LOG_DIR"
echo "=== Vault Sync Started: $(date) ===" >> "$LOGFILE"

# Step 1: Convert any new source files to Markdown
"$VENV_PYTHON" "$CONVERTER" "$@" >> "$LOGFILE" 2>&1

# Step 1b: Duplicate check — auto-resolve any PMID/DOI conflicts after conversion
echo "--- Duplicate check + auto-resolve ---" >> "$LOGFILE"
"$VENV_PYTHON" "$DEDUP_CHECK" --auto-resolve >> "$LOGFILE" 2>&1

# Step 1c: Tier 2 enrichment (PubMed metadata)
if [[ "$*" != *"--dry-run"* ]]; then
    echo "--- PubMed enrichment (Tier 2) ---" >> "$LOGFILE"
    "$VENV_PYTHON" "$ENRICH_PAPER" --all >> "$LOGFILE" 2>&1
fi

# Step 1d: Tier 3 LLM metadata enrichment for stragglers (max 3/run)
if [[ "$*" != *"--dry-run"* && "$*" != *"--skip-integrate"* ]]; then
    echo "--- LLM metadata enrichment (Tier 3) ---" >> "$LOGFILE"
    "$VENV_PYTHON" "$ENRICH_LLM" --all --batch 3 >> "$LOGFILE" 2>&1
fi

# Step 1d': Re-check duplicates after LLM title correction.
# Step 1b runs immediately after PDF conversion, when titles are whatever
# Docling extracted from the PDF — often noisy. enrich-paper.py (1c) and
# enrich-llm.py (1d) may correct that title to match the canonical paper,
# but by then Step 1b has already finished. A title-only duplicate (a paper
# without PMID/DOI that matches an enriched paper after title correction)
# survives Step 1b's pass. This second pass catches that case. Idempotent —
# short-circuits on a clean vault.
if [[ "$*" != *"--dry-run"* ]]; then
    echo "--- Duplicate check pass 2 (post-enrichment) ---" >> "$LOGFILE"
    "$VENV_PYTHON" "$DEDUP_CHECK" --auto-resolve >> "$LOGFILE" 2>&1
fi

# Step 1e: Upgrade abstract-only stubs — re-check PMC for body text (max 10/run)
if [[ "$*" != *"--dry-run"* ]]; then
    echo "--- Upgrading abstract-only stubs ---" >> "$LOGFILE"
    "$VENV_PYTHON" "$UPGRADE_STUBS" --all --batch 10 >> "$LOGFILE" 2>&1
fi

# Step 1f: Detect when a preprint has been formally published (max 5/run)
if [[ "$*" != *"--dry-run"* ]]; then
    echo "--- Upgrading preprints to published versions ---" >> "$LOGFILE"
    "$VENV_PYTHON" "$UPGRADE_PREPRINTS" --all --batch 5 >> "$LOGFILE" 2>&1
fi

# Step 1g: Optional deep-dive summary generator (Supabase-driven)
if [[ "$*" != *"--dry-run"* && "$*" != *"--skip-integrate"* ]]; then
    echo "--- Deep-dive summary generation ---" >> "$LOGFILE"
    "$VENV_PYTHON" "$GENERATE_SUMMARY" --batch 3 >> "$LOGFILE" 2>&1
fi

# Step 1h: Per-paper LLM tagging (max 20/run)
if [[ "$*" != *"--dry-run"* && "$*" != *"--skip-integrate"* ]]; then
    echo "--- Paper integration (LLM tagging) ---" >> "$LOGFILE"
    "$INTEGRATE_PAPER" --batch 20 >> "$LOGFILE" 2>&1
fi

# Step 2: Re-index the vault collection
if [[ "$*" != *"--dry-run"* ]]; then
    echo "--- QMD update + embed ---" >> "$LOGFILE"
    "$QMD_WRAPPER" update >> "$LOGFILE" 2>&1
    "$QMD_WRAPPER" embed --collection "${QMD_COLLECTION:-science}" >> "$LOGFILE" 2>&1
fi

# Step 2a: QMD storage health checks (non-fatal — the downstream chain still runs)
# Two checks:
#   (1) vec0 vs content_vectors row-count parity. Catches the silent
#       dim-mismatch wipe pattern in which an off-dimension embedding DROPs
#       the vec0 table while leaving content_vectors intact. Now also blocked
#       at the source by the store.ts patch — this check is defense in depth.
#   (2) Per-hash internal seq-gap detection. content_vectors stores chunks
#       (hash, seq) for each document. If chunks 0..N were embedded but the
#       middle of the range has gaps (e.g. transient embedding-API errors
#       during bulk embed), QMD's "needs embedding" query keys on seq=0 only —
#       so plain `qmd embed` will NOT retry the missing internal chunks. The
#       gap is permanent and invisible to row-count parity.
# Both warnings log loudly so the librarian / next-day review catches them.
if [[ "$*" != *"--dry-run"* ]]; then
    echo "--- QMD storage health checks ---" >> "$LOGFILE"
    "$VENV_PYTHON" - "${QMD_INDEX:-$HOME/.cache/qmd/index.sqlite}" << 'PYEOF' >> "$LOGFILE" 2>&1
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])

# Check 1: row-count parity
cv = db.execute('SELECT COUNT(*) FROM content_vectors').fetchone()[0]
vec = db.execute('SELECT COUNT(*) FROM vectors_vec_rowids').fetchone()[0]
delta = cv - vec
pct = (delta / cv * 100) if cv else 0.0
if abs(pct) > 1.0:
    print(f'WARNING vec0 row-count mismatch: content_vectors={cv}, vectors_vec_rowids={vec}, delta={delta} ({pct:.1f}%). The live vec0 store and log have diverged — investigate.')
else:
    print(f'OK row-count parity: vec0={vec}, content_vectors={cv}, delta={delta} ({pct:.2f}%)')

# Check 2: per-hash internal seq gaps
gaps = db.execute('''
    SELECT d.collection, d.path, cv.hash,
           COUNT(*) AS actual, MAX(cv.seq)+1 AS expected, (MAX(cv.seq)+1) - COUNT(*) AS gap
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1
    GROUP BY cv.hash
    HAVING COUNT(*) < MAX(cv.seq) + 1
    ORDER BY gap DESC
''').fetchall()
if gaps:
    total_missing = sum(g[5] for g in gaps)
    print(f'WARNING internal seq gaps: {len(gaps)} document hash(es) have non-contiguous chunk sequences ({total_missing} chunk(s) missing). Invisible to plain qmd embed; needs targeted repair (DELETE content_vectors for affected hashes, then re-embed).')
    for collection, path, h, actual, expected, gap in gaps[:10]:
        print(f'  - [{collection}] {path} (hash {h[:8]}...): {actual}/{expected} chunks, missing {gap}')
    if len(gaps) > 10:
        print(f'  ... and {len(gaps) - 10} more')
else:
    print('OK seq-gap check: 0 hashes with internal seq gaps')
PYEOF
fi

# Step 2b: Compute paper-to-paper neighbor sidecar (zero API calls)
if [[ "$*" != *"--dry-run"* ]]; then
    echo "--- Computing paper relationships ---" >> "$LOGFILE"
    "$RELATE_PAPERS" >> "$LOGFILE" 2>&1
fi

# Step 3: Regenerate topic clusters (graph community detection) and navigation index
if [[ "$*" != *"--dry-run"* ]]; then
    echo "--- Generating topic clusters (graph) ---" >> "$LOGFILE"
    "$VENV_PYTHON" "$CLUSTER_GRAPH" full-run \
        --resolution "${LEIDEN_RESOLUTION:-8.0}" \
        --percentile "${SOFT_PERCENTILE:-60}" \
        >> "$LOGFILE" 2>&1
    echo "--- Generating _index.md ---" >> "$LOGFILE"
    "$VENV_PYTHON" "$GENERATE_INDEX" >> "$LOGFILE" 2>&1
fi

# Step 4: Rebuild PaperQA2 index incrementally (body-sha256 tracked)
if [[ "$*" != *"--dry-run"* && "$*" != *"--skip-pqa"* ]]; then
    echo "--- PaperQA2 index update ---" >> "$LOGFILE"
    "$VENV_PYTHON" "$PQA_INDEX" >> "$LOGFILE" 2>&1
fi

echo "=== Vault Sync Finished: $(date) ===" >> "$LOGFILE"
