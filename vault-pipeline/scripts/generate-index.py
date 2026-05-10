#!/usr/bin/env python3
"""
generate-index.py — Generate the minimal lookup index of the vault.

Reads YAML frontmatter from all .md files and produces _index.md: a compact,
chronologically sorted table of every paper (one row each) with no lab
sections, no key findings, and no interpretive content.

This is the orientation layer — it tells an LLM agent what exists in the vault
so it can plan retrieval. Navigation (where to look) is in _topic-*.md files.

Output goes to $NAV_DIR/_index.md.

Required env: VAULT_DIR. Optional env: NAV_DIR (default: $VAULT_DIR/../nav).

Usage:
    python generate-index.py           # Write _index.md
    python generate-index.py --dry-run # Print to stdout only
"""

import os
import re
import sys
from datetime import datetime
from pathlib import Path

VAULT_DIR = Path(os.environ.get("VAULT_DIR") or sys.exit("ERROR: VAULT_DIR not set in environment")).expanduser()
NAV_DIR = Path(os.environ.get("NAV_DIR", str(VAULT_DIR.parent / "nav"))).expanduser()
OUTPUT_FILE = NAV_DIR / "_index.md"
FRONTMATTER_RE = re.compile(r'^---\s*\n(.*?)\n---', re.DOTALL)
TOPIC_HEADER_RE = re.compile(r'Papers:\s*(\d+)')


def discover_topic_files() -> list[tuple[str, int, str]]:
    """Glob $NAV_DIR/_topic-*.md and parse each file's header.

    Returns (filename, paper_count, title) tuples, sorted by paper_count desc
    then filename — deterministic across runs so the index footer doesn't
    churn when membership barely shifts.

    Cluster files are written by cluster-vault-graph.py with this header:
        # Topic: Title
        Generated: DATE | Papers: N (core: N, related: N)
    """
    discovered = []
    for path in NAV_DIR.glob("_topic-*.md"):
        try:
            head = path.read_text(encoding="utf-8", errors="replace").splitlines()[:2]
        except OSError:
            continue
        title = head[0].lstrip("# ").strip() if head else path.stem
        if title.lower().startswith("topic:"):
            title = title.split(":", 1)[1].strip()
        count_match = TOPIC_HEADER_RE.search(head[1]) if len(head) > 1 else None
        paper_count = int(count_match.group(1)) if count_match else 0
        discovered.append((path.name, paper_count, title))
    discovered.sort(key=lambda t: (-t[1], t[0]))
    return discovered


def parse_yaml_value(val_str: str):
    val_str = val_str.strip()
    if not val_str or val_str in ("null", "~"):
        return None
    if val_str.startswith("[") and val_str.endswith("]"):
        inner = val_str[1:-1]
        if not inner.strip():
            return []
        items = [x.strip().strip('"').strip("'") for x in inner.split(",")]
        return [x for x in items if x]
    return val_str.strip('"').strip("'")


def parse_frontmatter(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}

    fm = {}
    current_key = None

    for line in m.group(1).splitlines():
        if re.match(r"^\s+-\s", line):
            if current_key is not None:
                val = line.strip().lstrip("- ").strip().strip('"')
                if isinstance(fm.get(current_key), list):
                    fm[current_key].append(val)
                else:
                    fm[current_key] = [val]
            continue

        if ":" not in line:
            continue

        key, _, raw_val = line.partition(":")
        key = key.strip().lower()
        raw_val = raw_val.strip()

        parsed = parse_yaml_value(raw_val)
        if isinstance(parsed, list):
            fm[key] = parsed
        elif parsed is None:
            fm[key] = []
        else:
            fm[key] = parsed

        current_key = key

    return fm


def first_author(fm: dict) -> str:
    """Return 'LastName' of first author."""
    authors = fm.get("authors")
    if isinstance(authors, list) and authors:
        name = authors[0].strip()
    elif isinstance(authors, str) and authors:
        name = authors.split(",")[0].strip()
    else:
        return "?"
    parts = name.rstrip(".").split()
    if not parts:
        return "?"
    last = parts[-1].rstrip(".")
    if len(parts) > 1 and len(last) <= 4 and last.isupper():
        return parts[0]
    return parts[-1]


# Generic biomedical journal abbreviations. Add or replace for your field.
JOURNAL_ABBREVS = {
    "cell metabolism": "Cell Metab",
    "the journal of clinical investigation": "JCI",
    "journal of clinical investigation": "JCI",
    "nature communications": "Nat Commun",
    "nature metabolism": "Nat Metab",
    "cell reports": "Cell Rep",
    "endocrinology": "Endocrinology",
    "scientific reports": "Sci Rep",
    "diabetes": "Diabetes",
    "obesity": "Obesity",
    "molecular metabolism": "Mol Metab",
    "nutrients": "Nutrients",
    "physiology & behavior": "Physiol Behav",
    "annual review of nutrition": "Annu Rev Nutr",
    "proceedings of the national academy of sciences": "PNAS",
    "the journal of neuroscience": "J Neurosci",
    "journal of neuroscience": "J Neurosci",
    "neuropharmacology": "Neuropharmacol",
    "american journal of physiology": "Am J Physiol",
    "metabolism": "Metabolism",
    "plos one": "PLoS ONE",
    "elife": "eLife",
    "nature": "Nature",
    "cell": "Cell",
    "nature medicine": "Nat Med",
    "science": "Science",
    "appetite": "Appetite",
    "chemical senses": "Chem Senses",
    "european journal of neuroscience": "Eur J Neurosci",
    "frontiers in neuroendocrinology": "Front Neuroendocrinol",
    "frontiers in endocrinology": "Front Endocrinol",
    "philosophical transactions": "Phil Trans R Soc B",
}


def short_journal(journal: str) -> str:
    """Abbreviate common journal names."""
    j = journal.lower().strip()
    for long, short in JOURNAL_ABBREVS.items():
        if j.startswith(long):
            return short
    words = journal.split()
    return " ".join(words[:3]) if len(words) > 3 else journal


def get_primary_topics(fm: dict, max_topics: int = 3) -> str:
    sub = fm.get("subtopics", [])
    if not isinstance(sub, list) or not sub:
        return ""
    specific = sub[-max_topics:] if len(sub) > max_topics else sub
    return "; ".join(specific)


def sort_key(item):
    fname, fm = item
    year = fm.get("year")
    try:
        yr = int(year) if year else 9999
    except (ValueError, TypeError):
        yr = 9999
    return (yr, fname.lower())


def generate_index(papers: list[tuple[str, dict]]) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    total = len(papers)
    has_pmid = sum(1 for _, fm in papers if fm.get("pmid"))

    sorted_papers = sorted(papers, key=sort_key)
    existing_topics = discover_topic_files()

    lines = [
        "# Vault Index",
        f"Generated: {now}  |  Papers: {total}  |  PMID coverage: {has_pmid}/{total}",
        "",
        "Minimal lookup table. Sorted by year (ascending). No interpretive content.",
        "Use this file to confirm what's in the vault, then navigate to `_topic-*.md` files for relevant clusters.",
        "",
        "| File | PMID | Year | First Author | Journal | Type | Topics |",
        "|------|------|------|--------------|---------|------|--------|",
    ]

    for fname, fm in sorted_papers:
        pmid = fm.get("pmid") or "—"
        year = fm.get("year") or "?"
        author = first_author(fm)
        journal = short_journal(fm.get("journal") or "") if fm.get("journal") else "?"
        ptype = fm.get("type") or "?"
        topics = get_primary_topics(fm)
        stem = fname[:-3] if fname.endswith(".md") else fname
        if len(stem) > 50:
            stem = stem[:47] + "..."
        lines.append(f"| {stem} | {pmid} | {year} | {author} | {journal} | {ptype} | {topics} |")

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## Topic Cluster Files")
    lines.append("")
    lines.append("For navigation: read the relevant `_topic-*.md` file(s) before retrieving individual papers.")
    lines.append("")

    if existing_topics:
        for fname, count, title in existing_topics:
            lines.append(f"- **{fname}** ({count}p) — {title}")
    else:
        lines.append("_(Topic cluster files not yet generated — run `cluster-vault-graph.py`)_")

    lines.append("")
    return "\n".join(lines)


def main():
    dry_run = "--dry-run" in sys.argv

    papers = []
    for md in sorted(VAULT_DIR.glob("*.md")):
        if md.name.startswith("_"):
            continue
        fm = parse_frontmatter(md)
        if not fm:
            continue
        papers.append((md.name, fm))

    print(f"Loaded {len(papers)} papers from vault.", file=sys.stderr)

    index_text = generate_index(papers)

    if dry_run:
        print(index_text)
    else:
        NAV_DIR.mkdir(parents=True, exist_ok=True)
        OUTPUT_FILE.write_text(index_text, encoding="utf-8")
        line_count = index_text.count("\n")
        print(f"Written: {OUTPUT_FILE.name}  ({line_count} lines)", file=sys.stderr)
        print(f"Done.", file=sys.stderr)


if __name__ == "__main__":
    main()
