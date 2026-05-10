#!/usr/bin/env python3
"""
enrich-llm.py — Tier 3 metadata enrichment using Claude Sonnet.

Reads vault papers where PubMed enrichment failed (enrichment_status: failed
or missing key fields), sends the first ~60 lines of body text to Sonnet, and
asks it to extract title, authors, year, journal, and DOI.

This is the safety net — most papers should be caught by enrich-paper.py
(PubMed). This script only handles stragglers: preprints, very new papers,
obscure journals, or PDFs with heavily mangled text.

Usage:
    python enrich-llm.py --all              # All papers with enrichment_status: failed
    python enrich-llm.py --batch 5          # Limit to N papers per run (for cron)
    python enrich-llm.py --dry-run --all    # Preview without writing
    python enrich-llm.py FILE [FILE ...]    # Specific files

Required env: VAULT_DIR. Optional: LOG_DIR (default /tmp), CLAUDE_BIN (default 'claude').
"""

import argparse
import json
import os
import re
import subprocess
import sys
import datetime
from pathlib import Path

VAULT_DIR = Path(os.environ.get("VAULT_DIR") or sys.exit("ERROR: VAULT_DIR not set in environment")).expanduser()
LOG_DIR = Path(os.environ.get("LOG_DIR", "/tmp")).expanduser()
LOG_FILE = LOG_DIR / "enrich-llm.log"
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")

LLM_FIELDS = {"title", "authors", "year", "journal", "doi"}

PRESERVE_IF_NONEMPTY = {"key_findings", "related_papers", "lab", "type", "full_text",
                        "tags", "integrated", "pmid", "pmcid", "subtopics"}

FIELD_ORDER = [
    "pmid", "pmcid", "title", "authors", "year", "journal",
    "volume", "issue", "pages", "doi", "type", "lab", "full_text",
    "enrichment_status", "subtopics", "key_findings", "related_papers",
]

PROMPT_TEMPLATE = """\
You are extracting bibliographic metadata from a scientific paper's first page.

Below is the first ~60 lines of a markdown-converted scientific paper. Extract:
- title: The full paper title (NOT section headers like "Research Article" or "Original Article")
- authors: A JSON array of author names in "FirstName LastName" format
- year: Publication year (integer)
- journal: Journal name
- doi: DOI string (e.g. "10.1234/example") or empty string if not found

Reply with ONLY a JSON object, no markdown fences, no explanation:
{{"title": "...", "authors": ["..."], "year": NNNN, "journal": "...", "doi": "..."}}

--- BEGIN PAPER TEXT ---
{body_text}
--- END PAPER TEXT ---"""


def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def parse_frontmatter(text):
    match = re.match(r'^---\n(.*?)\n---\n?', text, re.DOTALL)
    if not match:
        return {}, text
    fm_raw = match.group(1)
    body = text[match.end():]
    try:
        import yaml
        fm = yaml.safe_load(fm_raw) or {}
    except ImportError:
        fm = _parse_fm_minimal(fm_raw)
    except Exception as e:
        log(f"  YAML parse error: {e}")
        fm = {}
    return fm, body


def _parse_fm_minimal(text):
    result = {}
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r'^(\w+):\s*$', line)
        if m:
            key = m.group(1)
            items = []
            i += 1
            while i < len(lines) and lines[i].startswith("  - "):
                items.append(lines[i][4:].strip().strip('"'))
                i += 1
            result[key] = items
            continue
        m = re.match(r'^(\w+):\s*\[(.*)\]\s*$', line)
        if m:
            key, raw = m.group(1), m.group(2)
            result[key] = [x.strip().strip('"') for x in raw.split(",") if x.strip()]
            i += 1
            continue
        m = re.match(r'^(\w+):\s*(.*)', line)
        if m:
            key, val = m.group(1), m.group(2).strip()
            if val.startswith('"') and val.endswith('"'):
                val = val[1:-1]
            elif val.lower() == "true":
                val = True
            elif val.lower() == "false":
                val = False
            elif re.match(r'^\d{4}$', val):
                val = int(val)
            result[key] = val
        i += 1
    return result


def write_frontmatter(fm, body):
    lines = ["---"]
    written = set()
    for key in FIELD_ORDER:
        if key not in fm or fm[key] is None:
            continue
        written.add(key)
        _append_field(lines, key, fm[key])
    for key, val in fm.items():
        if key not in written and val is not None:
            _append_field(lines, key, val)
    lines.append("---")
    return "\n".join(lines) + "\n" + body


def _append_field(lines, key, val):
    if key == "title":
        escaped = str(val).replace('"', '\\"')
        lines.append(f'title: "{escaped}"')
    elif key in ("authors", "subtopics"):
        if isinstance(val, list):
            lines.append(f"{key}: [{', '.join(str(v) for v in val)}]")
        else:
            lines.append(f"{key}: {val}")
    elif key in ("key_findings", "related_papers"):
        if isinstance(val, list) and val:
            lines.append(f"{key}:")
            for item in val:
                if key == "key_findings":
                    escaped = str(item).replace('"', '\\"')
                    lines.append(f'  - "{escaped}"')
                else:
                    lines.append(f"  - {item}")
        else:
            lines.append(f"{key}: []")
    elif isinstance(val, bool):
        lines.append(f"{key}: {'true' if val else 'false'}")
    elif isinstance(val, int):
        lines.append(f"{key}: {val}")
    elif isinstance(val, str) and any(c in val for c in [':', '#', '{', '}']):
        escaped = val.replace('"', '\\"')
        lines.append(f'{key}: "{escaped}"')
    else:
        lines.append(f"{key}: {val}")


def call_sonnet(body_text):
    """Call Claude Sonnet via claude CLI to extract metadata. Returns dict or None."""
    prompt = PROMPT_TEMPLATE.format(body_text=body_text)
    try:
        result = subprocess.run(
            [CLAUDE_BIN, "-p", prompt, "--model", "sonnet", "--output-format", "text"],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            log(f"  claude CLI error: {result.stderr[:200]}")
            return None
        raw = result.stdout.strip()
        raw = re.sub(r'^```json\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
        return json.loads(raw)
    except json.JSONDecodeError as e:
        log(f"  JSON parse error: {e}")
        log(f"  Raw output: {result.stdout[:200]}")
        return None
    except subprocess.TimeoutExpired:
        log(f"  claude CLI timeout (>60s)")
        return None
    except FileNotFoundError:
        log(f"  claude CLI not found at: {CLAUDE_BIN}")
        return None
    except Exception as e:
        log(f"  Unexpected error: {e}")
        return None


def needs_llm_enrichment(fm):
    if not fm:
        return False
    if fm.get("enrichment_status") != "failed":
        return False
    title = str(fm.get("title", "")).strip()
    authors = fm.get("authors", [])
    if title and len(title) > 15 and authors and len(authors) > 0:
        return False
    return True


def enrich_file(filepath, dry_run=False):
    filepath = Path(filepath)
    log(f"\n{'[DRY RUN] ' if dry_run else ''}-- {filepath.name}")

    text = filepath.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(text)

    if not fm:
        log("  No frontmatter — skipping")
        return "skipped"

    if fm.get("type") == "grant":
        log("  Grant file — skipping")
        return "skipped"

    if fm.get("enrichment_status") == "llm":
        log("  Already LLM-enriched — skipping (use specific file to re-run)")
        return "skipped"

    if fm.get("enrichment_status") == "pubmed":
        log("  Already PubMed-enriched — skipping")
        return "skipped"

    body_lines = body.strip().split("\n")[:60]
    body_excerpt = "\n".join(body_lines)

    if len(body_excerpt.split()) < 50:
        log("  Body text too short for LLM extraction")
        return "failed"

    if dry_run:
        log(f"  [DRY RUN] Would send {len(body_excerpt)} chars to Sonnet")
        return "skipped"

    log(f"  Calling Sonnet ({len(body_excerpt)} chars)...")
    data = call_sonnet(body_excerpt)

    if not data:
        log("  LLM returned no usable data")
        return "failed"

    changes = []
    for field in LLM_FIELDS:
        new_val = data.get(field)
        if not new_val:
            continue
        if field in PRESERVE_IF_NONEMPTY and fm.get(field):
            continue

        old_val = fm.get(field)

        if field == "title" and old_val and len(str(old_val)) > 20:
            continue
        if field == "authors" and old_val and isinstance(old_val, list) and len(old_val) > 0:
            continue
        if field == "year" and old_val and isinstance(old_val, int) and 1950 <= old_val <= 2030:
            if isinstance(new_val, int) and 1950 <= new_val <= 2030:
                fn_year_match = re.search(r'((?:19|20)\d{2})', filepath.stem)
                if fn_year_match:
                    fn_year = int(fn_year_match.group(1))
                    if fn_year == old_val:
                        continue
                    if fn_year == new_val:
                        pass
                    else:
                        continue
                else:
                    continue

        if new_val != old_val:
            fm[field] = new_val
            changes.append(f"{field}: {str(old_val)[:35]!r} -> {str(new_val)[:35]!r}")

    if not changes:
        log("  LLM extraction matched existing data — no changes")
        fm["enrichment_status"] = "llm"
        filepath.write_text(write_frontmatter(fm, body), encoding="utf-8")
        return "skipped"

    fm["enrichment_status"] = "llm"

    for c in changes:
        log(f"  + {c}")

    filepath.write_text(write_frontmatter(fm, body), encoding="utf-8")
    log("  Saved (LLM-enriched)")
    return "enriched"


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", help=".md files to process")
    parser.add_argument("--all", action="store_true", help="All vault files needing LLM enrichment")
    parser.add_argument("--batch", type=int, default=0, help="Limit to N papers per run (0 = unlimited)")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing or calling LLM")
    args = parser.parse_args()

    if args.all:
        targets = []
        for f in sorted(VAULT_DIR.glob("*.md")):
            if f.name.startswith("_"):
                continue
            fm, _ = parse_frontmatter(f.read_text(encoding="utf-8"))
            if needs_llm_enrichment(fm):
                targets.append(f)
        if args.batch > 0:
            targets = targets[:args.batch]
        log(f"Processing {len(targets)} files (batch={args.batch or 'all'})")
    elif args.files:
        targets = [Path(f) for f in args.files]
    else:
        parser.print_help()
        sys.exit(1)

    counts = {"enriched": 0, "skipped": 0, "failed": 0}

    for f in targets:
        if not f.exists():
            log(f"Not found: {f}")
            counts["failed"] += 1
            continue
        result = enrich_file(f, dry_run=args.dry_run)
        counts[result] += 1

    log(f"\n{'='*60}")
    log(f"LLM Enriched: {counts['enriched']} | Skipped: {counts['skipped']} | "
        f"Failed: {counts['failed']}")


if __name__ == "__main__":
    main()
