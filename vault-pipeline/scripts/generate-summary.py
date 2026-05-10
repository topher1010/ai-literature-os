#!/usr/bin/env python3
"""
generate-summary.py — Generate 1-page summaries for deep-dive papers.

Optional component: only useful if you wire up the Supabase + frontend curation
flow. For each paper in Supabase where wants_deep_summary=true AND
full_text_summary is null, finds the corresponding vault file (by PMID), checks
that the vault has full text (enrichment_status=pmcid), generates a 1-page
summary via Claude CLI, and writes it back to Supabase.

Run via the cron pipeline, or manually:
    python generate-summary.py              # Process all pending
    python generate-summary.py --batch 3    # Limit to N per run
    python generate-summary.py --dry-run    # Preview without changes

Required env: VAULT_DIR, SUPABASE_URL, SUPABASE_ANON_KEY (or SUPABASE_SERVICE_KEY).
Optional env: LOG_DIR (default /tmp), CLAUDE_BIN (default 'claude'),
              RESEARCHER_PROFILE (one-line description for the relevance section).

If SUPABASE_URL is unset, this script exits cleanly — the rest of the pipeline
runs without it.
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

# ── Configuration ──────────────────────────────────────────────────────────────

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_ANON_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    # Optional component — exit cleanly if not configured
    print("generate-summary.py: SUPABASE_URL or KEY not set, skipping (this script is optional)")
    sys.exit(0)

VAULT_DIR = Path(os.environ.get("VAULT_DIR") or sys.exit("ERROR: VAULT_DIR not set in environment")).expanduser()
LOG_DIR = Path(os.environ.get("LOG_DIR", "/tmp")).expanduser()
LOG_FILE = LOG_DIR / "generate-summary.log"
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
RESEARCHER_PROFILE = os.environ.get("RESEARCHER_PROFILE", "").strip()

# Build the prompt. The "Relevance to Our Work" section only appears if a
# RESEARCHER_PROFILE is configured — otherwise it would be vacuous.
_RELEVANCE_BLOCK = ""
if RESEARCHER_PROFILE:
    _RELEVANCE_BLOCK = f"""
### Relevance to Our Work
How might this paper connect to: {RESEARCHER_PROFILE}? (2-3 sentences, or "No direct connection" if not applicable)
"""

SUMMARY_PROMPT = f"""You are a scientific writing assistant. Read the full text of the following paper and produce a structured 1-page summary (approximately 500-700 words).

Format:
## [Paper Title]
**Authors:** [First author et al., Year] | **Journal:** [Journal Name]

### Key Question
What central question or hypothesis does this paper address? (2-3 sentences)

### Approach
What methods or experimental design did the authors use? (3-4 sentences)

### Main Findings
The core results, stated precisely. Include key numbers, effect sizes, or statistical outcomes where they matter. (4-6 bullet points)

### Significance
Why does this matter for the field? What does it change about our understanding? (2-3 sentences)

### Limitations & Open Questions
What caveats should a reader keep in mind? What remains unresolved? (2-3 bullet points)
{_RELEVANCE_BLOCK}
---
Paper text follows:

"""


def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def _headers(prefer="return=minimal"):
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    }


def supabase_get(table, query_params):
    url = f"{SUPABASE_URL}/rest/v1/{table}?{query_params}"
    req = Request(url, headers=_headers())
    try:
        with urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except URLError as e:
        log(f"  Supabase GET error: {e}")
        return None


def supabase_patch(table, query_params, data):
    url = f"{SUPABASE_URL}/rest/v1/{table}?{query_params}"
    body = json.dumps(data).encode("utf-8")
    req = Request(url, data=body, headers=_headers(), method="PATCH")
    try:
        with urlopen(req, timeout=30) as r:
            return r.status
    except URLError as e:
        log(f"  Supabase PATCH error: {e}")
        return None


def find_vault_file_by_pmid(pmid):
    """Find a vault markdown file by PMID. Returns (Path, status, full_text) or (None, None, None)."""
    for f in VAULT_DIR.glob("*.md"):
        if f.name.startswith("_"):
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        m = re.search(r'^pmid:\s*(\S+)', text, re.MULTILINE)
        if m and m.group(1).strip() == str(pmid):
            es = re.search(r'^enrichment_status:\s*(\S+)', text, re.MULTILINE)
            status = es.group(1).strip() if es else ""
            return f, status, text
    return None, None, None


def generate_summary(vault_path, paper_text):
    """Generate a 1-page summary using Claude CLI. Returns summary text or None."""
    m = re.match(r'^---\n.*?\n---\n?', paper_text, re.DOTALL)
    body = paper_text[m.end():] if m else paper_text

    if len(body) > 80000:
        body = body[:80000] + "\n\n[... truncated for length]"

    prompt = SUMMARY_PROMPT + body

    try:
        result = subprocess.run(
            [CLAUDE_BIN, "-p", prompt, "--model", "sonnet"],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            log(f"  Claude CLI error (exit {result.returncode})")
            if result.stderr.strip():
                log(f"    {result.stderr.strip()[:200]}")
            return None
        summary = result.stdout.strip()
        if len(summary) < 100:
            log(f"  Summary too short ({len(summary)} chars) — likely failed")
            return None
        return summary
    except subprocess.TimeoutExpired:
        log(f"  Claude CLI timed out")
        return None
    except FileNotFoundError:
        log(f"  Claude CLI not found at {CLAUDE_BIN}")
        return None


def fetch_pending_summaries():
    return supabase_get(
        "papers",
        "wants_deep_summary=eq.true&full_text_summary=is.null&select=id,paper_id,pmid,doi,title",
    )


def push_summary(paper_id, summary_text):
    status = supabase_patch(
        "papers",
        f"id=eq.{paper_id}",
        {
            "full_text_summary": summary_text,
            "summarized_date": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        },
    )
    return status and 200 <= status < 300


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--batch", type=int, default=0,
                        help="Limit to N papers per run (0 = unlimited)")
    args = parser.parse_args()

    log(f"\n{'='*60}")
    log(f"generate-summary.py started {'(DRY RUN)' if args.dry_run else ''}")

    papers = fetch_pending_summaries()
    if papers is None:
        log("Failed to fetch from Supabase — aborting")
        sys.exit(1)

    if not papers:
        log("No papers pending summary generation")
        return

    log(f"Found {len(papers)} papers wanting deep summaries")

    if args.batch > 0:
        papers = papers[:args.batch]

    counts = {"generated": 0, "no_full_text": 0, "not_in_vault": 0, "failed": 0}

    for paper in papers:
        pid = paper.get("id")
        pmid = paper.get("pmid")
        title = (paper.get("title") or "")[:65]

        log(f"\n-- [{pid}] {title}")

        if not pmid:
            log(f"  No PMID — cannot find vault file")
            counts["not_in_vault"] += 1
            continue

        vault_path, enrichment_status, full_text = find_vault_file_by_pmid(pmid)
        if not vault_path:
            log(f"  PMID {pmid} not found in vault — add it via add-paper.py first")
            counts["not_in_vault"] += 1
            continue

        if enrichment_status != "pmcid":
            log(f"  enrichment_status={enrichment_status} — no full text yet, skipping")
            counts["no_full_text"] += 1
            continue

        log(f"  Found vault file: {vault_path.name} ({len(full_text)} chars)")

        if args.dry_run:
            log(f"  [DRY RUN] Would generate summary and push to Supabase")
            counts["generated"] += 1
            continue

        log(f"  Generating 1-page summary via Claude...")
        summary = generate_summary(vault_path, full_text)
        if not summary:
            counts["failed"] += 1
            continue

        log(f"  Summary generated: {len(summary)} chars")

        if push_summary(pid, summary):
            log(f"  Pushed to Supabase")
            counts["generated"] += 1
        else:
            log(f"  Failed to push summary to Supabase")
            counts["failed"] += 1

    log(f"\n{'='*60}")
    log(f"Generated: {counts['generated']} | No full text: {counts['no_full_text']} | "
        f"Not in vault: {counts['not_in_vault']} | Failed: {counts['failed']}")


if __name__ == "__main__":
    main()
