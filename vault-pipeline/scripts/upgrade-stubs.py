#!/usr/bin/env python3
"""
upgrade-stubs.py — Nightly upgrade of vault papers to best available text.

Two phases:
  Phase 1: Abstract-only stubs → PMC full text
    Finds papers with enrichment_status: abstract-only, re-checks PubMed for
    a PMCID, and upgrades with full PMC text if available.

  Phase 2: PDF/Docling text → PMC full text
    Finds papers with enrichment_status: pubmed/llm that have full_text: true
    (from PDF conversion). If PMC has full JATS text that is both (a) has real
    body sections and (b) is longer than the existing text, replaces with PMC.

Run in cron via sync-vault.sh. Processes up to --batch N papers per run.

Usage:
    python upgrade-stubs.py --all           # Check all eligible papers
    python upgrade-stubs.py --batch 5       # Limit to N papers per phase per run
    python upgrade-stubs.py --dry-run --all # Preview without writing

Required env: VAULT_DIR. Optional: LOG_DIR (default /tmp).
"""

import argparse
import datetime
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen

VAULT_DIR = Path(os.environ.get("VAULT_DIR") or sys.exit("ERROR: VAULT_DIR not set in environment")).expanduser()
LOG_DIR = Path(os.environ.get("LOG_DIR", "/tmp")).expanduser()
LOG_FILE = LOG_DIR / "upgrade-stubs.log"
NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
RATE_LIMIT_DELAY = 0.4

FIELD_ORDER = [
    "pmid", "pmcid", "title", "authors", "year", "journal",
    "volume", "issue", "pages", "doi", "type", "lab", "full_text",
    "enrichment_status", "subtopics", "key_findings", "related_papers",
]


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
        fm = {}
    except Exception:
        fm = {}
    if fm.get("pmid") is not None:
        fm["pmid"] = str(fm["pmid"])
    return fm, body


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


def ncbi_get(endpoint, params):
    url = f"{NCBI_BASE}/{endpoint}?{urlencode(params)}"
    time.sleep(RATE_LIMIT_DELAY)
    try:
        with urlopen(url, timeout=30) as r:
            return r.read().decode("utf-8", errors="replace")
    except URLError as e:
        log(f"  Network error: {e}")
        return None


def fetch_pmcid_for_pmid(pmid):
    data = ncbi_get("efetch.fcgi", {"db": "pubmed", "id": pmid, "retmode": "xml"})
    if not data:
        return None
    try:
        root = ET.fromstring(data)
        id_list = root.find(".//PubmedData/ArticleIdList")
        if id_list is None:
            id_list = root.find(".//ArticleIdList")
        if id_list is not None:
            for id_el in id_list.findall("ArticleId"):
                if id_el.get("IdType") == "pmc":
                    return id_el.text
    except ET.ParseError:
        pass
    return None


def fetch_pmc_text(pmcid):
    pmcid_num = re.sub(r'^PMC', '', str(pmcid))
    data = ncbi_get("efetch.fcgi", {"db": "pmc", "id": pmcid_num, "retmode": "xml"})
    if not data:
        return None
    try:
        root = ET.fromstring(data)
        return _jats_to_markdown(root)
    except ET.ParseError:
        return None


def _jats_to_markdown(root):
    parts = []

    def text_of(el):
        chunks = []
        if el.text:
            chunks.append(el.text.strip())
        for child in el:
            chunks.append(text_of(child))
            if child.tail:
                chunks.append(child.tail.strip())
        return " ".join(c for c in chunks if c)

    def process_section(sec, depth=2):
        title_el = sec.find("title")
        if title_el is not None:
            title_text = text_of(title_el)
            if title_text:
                parts.append(f"\n{'#' * depth} {title_text}\n")
        for child in sec:
            tag = child.tag
            if tag == "title":
                continue
            elif tag == "p":
                para = text_of(child)
                if para and len(para) > 10:
                    parts.append(para + "\n")
            elif tag == "sec":
                process_section(child, depth + 1)
            elif tag == "list":
                for item in child.findall("list-item"):
                    item_text = text_of(item)
                    if item_text:
                        parts.append(f"- {item_text}")
                parts.append("")

    for abstract in root.findall(".//abstract"):
        abs_text = text_of(abstract)
        if abs_text:
            parts.append("## Abstract\n")
            parts.append(abs_text + "\n")

    body = root.find(".//body")
    if body is not None:
        for sec in body.findall("sec"):
            process_section(sec)

    return "\n".join(parts).strip() if parts else None


def upgrade_file(filepath, dry_run=False):
    """Phase 1: upgrade abstract-only stub to PMC full text."""
    filepath = Path(filepath)
    log(f"\n-- {filepath.name}")

    text = filepath.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(text)

    if not fm:
        log("  No frontmatter — skipping")
        return "skipped"

    pmid = fm.get("pmid")
    if not pmid:
        log("  No PMID — skipping")
        return "skipped"

    if fm.get("enrichment_status") != "abstract-only":
        log(f"  Status is {fm.get('enrichment_status')!r} — skipping")
        return "skipped"

    if fm.get("pmcid"):
        log(f"  Already has PMCID {fm['pmcid']} — skipping")
        return "skipped"

    log(f"  Checking PubMed for PMCID (PMID {pmid})...")
    pmcid = fetch_pmcid_for_pmid(pmid)
    if not pmcid:
        log("  No PMCID found yet")
        return "skipped"

    log(f"  New PMCID found: {pmcid}")

    pmc_text = fetch_pmc_text(pmcid)
    if not pmc_text:
        log(f"  PMC fetch failed for {pmcid}")
        return "failed"

    pmc_has_body = pmc_text.count('\n## ') > 1
    if not pmc_has_body:
        log(f"  PMC returned abstract-only text (no body sections) — skipping")
        if not fm.get("pmcid"):
            fm["pmcid"] = pmcid
            filepath.write_text(write_frontmatter(fm, body), encoding="utf-8")
            log(f"  Saved PMCID but status stays abstract-only")
        return "skipped"

    log(f"  PMC full text: {len(pmc_text)} chars")

    if dry_run:
        log(f"  [DRY RUN] Would upgrade to pmcid status")
        return "upgraded"

    fm["pmcid"] = pmcid
    fm["full_text"] = True
    fm["enrichment_status"] = "pmcid"

    new_body = "\n" + pmc_text + "\n"
    filepath.write_text(write_frontmatter(fm, new_body), encoding="utf-8")
    log(f"  Upgraded to pmcid status")
    return "upgraded"


def upgrade_to_pmc(filepath, dry_run=False):
    """Phase 2: upgrade a PDF-converted or pubmed-enriched paper to PMC full text.
    Only replaces if PMC text has body sections AND is longer than existing text.
    """
    filepath = Path(filepath)
    log(f"\n-- {filepath.name} [PMC upgrade check]")

    text = filepath.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(text)

    if not fm:
        log("  No frontmatter — skipping")
        return "skipped"

    pmid = fm.get("pmid")
    if not pmid:
        log("  No PMID — skipping")
        return "skipped"

    pmcid = fm.get("pmcid")
    if not pmcid:
        log(f"  Checking PubMed for PMCID (PMID {pmid})...")
        pmcid = fetch_pmcid_for_pmid(pmid)
        if not pmcid:
            log("  No PMCID found — skipping")
            return "skipped"
        log(f"  Found PMCID: {pmcid}")

    pmc_text = fetch_pmc_text(pmcid)
    if not pmc_text:
        log(f"  PMC fetch failed for {pmcid}")
        return "failed"

    pmc_has_body = pmc_text.count('\n## ') > 1
    if not pmc_has_body:
        log(f"  PMC returned abstract-only (no body sections) — keeping existing text")
        if not fm.get("pmcid"):
            fm["pmcid"] = pmcid
            filepath.write_text(write_frontmatter(fm, body), encoding="utf-8")
            log(f"  Saved PMCID but kept existing body")
        return "skipped"

    existing_len = len(body.strip())
    pmc_len = len(pmc_text.strip())
    if pmc_len <= existing_len:
        log(f"  PMC text ({pmc_len} chars) is not longer than existing ({existing_len} chars) — keeping existing")
        if not fm.get("pmcid"):
            fm["pmcid"] = pmcid
            filepath.write_text(write_frontmatter(fm, body), encoding="utf-8")
        return "skipped"

    log(f"  PMC full text: {pmc_len} chars (existing: {existing_len} chars) — upgrading")

    if dry_run:
        log(f"  [DRY RUN] Would upgrade to pmcid status")
        return "upgraded"

    fm["pmcid"] = pmcid
    fm["full_text"] = True
    fm["enrichment_status"] = "pmcid"
    new_body = "\n" + pmc_text + "\n"
    filepath.write_text(write_frontmatter(fm, new_body), encoding="utf-8")
    log(f"  Upgraded PDF/pubmed text to PMC full text")
    return "upgraded"


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", help=".md files to check")
    parser.add_argument("--all", action="store_true", help="All abstract-only stubs")
    parser.add_argument("--batch", type=int, default=0, help="Limit to N papers per run (0 = unlimited)")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()

    if not args.all and not args.files:
        parser.print_help()
        sys.exit(1)

    if args.all:
        abstract_targets = []
        pmc_upgrade_targets = []
        for f in sorted(VAULT_DIR.glob("*.md")):
            if f.name.startswith("_"):
                continue
            fm, _ = parse_frontmatter(f.read_text(encoding="utf-8"))
            status = fm.get("enrichment_status", "")
            if status == "abstract-only" and fm.get("pmid"):
                abstract_targets.append(f)
            elif status in ("pubmed", "llm") and fm.get("pmid") and fm.get("full_text"):
                pmc_upgrade_targets.append(f)

        if args.batch > 0:
            abstract_targets = abstract_targets[:args.batch]
            pmc_upgrade_targets = pmc_upgrade_targets[:args.batch]
        log(f"Found {len(abstract_targets)} abstract-only stubs + "
            f"{len(pmc_upgrade_targets)} PDF/pubmed candidates for PMC upgrade "
            f"(batch={args.batch or 'all'})")
    else:
        abstract_targets = [Path(f) for f in args.files]
        pmc_upgrade_targets = []

    counts = {"upgraded": 0, "skipped": 0, "failed": 0}

    for f in abstract_targets:
        if not f.exists():
            log(f"Not found: {f}")
            counts["failed"] += 1
            continue
        result = upgrade_file(f, dry_run=args.dry_run)
        counts[result] += 1

    for f in pmc_upgrade_targets:
        if not f.exists():
            log(f"Not found: {f}")
            counts["failed"] += 1
            continue
        result = upgrade_to_pmc(f, dry_run=args.dry_run)
        counts[result] += 1

    log(f"\n{'='*60}")
    log(f"Upgraded: {counts['upgraded']} | Skipped: {counts['skipped']} | "
        f"Failed: {counts['failed']}")


if __name__ == "__main__":
    main()
