#!/usr/bin/env python3
"""
check-duplicates.py — Detect duplicate papers in the vault by PMID/DOI/title.

Builds a registry of all PMID and DOI values from existing vault files, then
checks one or more candidate files against that registry. Exits 0 if no
duplicates found, exits 1 if any duplicates are detected.

Designed for integration into sync-vault.sh to catch newly converted files
that duplicate an existing vault entry (e.g., the Endnote pipeline exported
the same paper twice under different filenames).

Usage:
    # Check a specific file against the vault
    python check-duplicates.py NEWFILE.md

    # Check all files (reports all duplicate pairs found in vault)
    python check-duplicates.py --all

    # Print registry stats only
    python check-duplicates.py --stats

    # Auto-resolve: keep best canonical, delete others
    python check-duplicates.py --auto-resolve

Required env: VAULT_DIR.

Canonical-pick scoring (see pick_canonical) is metadata-driven:
PMID > PMCID-grade > full_text > integrated > word_count > filename length.
Filename length / file size are deliberately the *last* signal, so an
Endnote re-download with a longer junk filename can't outrank a properly
enriched canonical file.
"""

import os
import re
import sys
from datetime import datetime
from pathlib import Path

VAULT_DIR = Path(os.environ.get("VAULT_DIR") or sys.exit("ERROR: VAULT_DIR not set in environment")).expanduser()
FRONTMATTER_RE = re.compile(r'^---\s*\n(.*?)\n---', re.DOTALL)


def parse_frontmatter(path: Path) -> dict:
    """Extract YAML frontmatter fields we care about without a full YAML parser."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}

    fm = {
        "pmid": None, "doi": None, "type": None, "title": None,
        "full_text": False, "enrichment_status": None, "integrated": None,
    }
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip().lower()
        val = val.strip().strip('"').strip("'")
        if key not in fm:
            continue
        if key == "full_text":
            fm[key] = val.lower() in ("true", "yes", "1")
        else:
            fm[key] = val if val not in ("", "null", "~") else None

    body = text[m.end():]
    fm["body_word_count"] = len(body.split())
    return fm


def normalize_title(title: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace — for fuzzy title matching."""
    t = title.lower()
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:80]


def build_registry(exclude: set[Path] | None = None) -> dict:
    """Scan all .md files in vault (excluding _*.md and `exclude`).

    Returns nested dict:
        registry["pmid"][pmid_str]    = [Path, ...]
        registry["doi"][doi_str]      = [Path, ...]
        registry["title"][norm_title] = [(Path, has_pmid_bool), ...]
    """
    registry = {"pmid": {}, "doi": {}, "title": {}}
    exclude = exclude or set()

    for md in sorted(VAULT_DIR.glob("*.md")):
        if md.name.startswith("_") or md in exclude:
            continue
        fm = parse_frontmatter(md)

        if fm.get("type") == "grant":
            continue

        pmid = fm.get("pmid")
        doi = fm.get("doi")
        title = fm.get("title") or ""

        if pmid:
            registry["pmid"].setdefault(pmid, []).append(md)
        if doi:
            registry["doi"].setdefault(doi.lower(), []).append(md)

        if title and len(title) > 20:
            nt = normalize_title(title)
            registry["title"].setdefault(nt, []).append((md, bool(pmid)))

    return registry


def check_file(candidate: Path, registry: dict) -> list[tuple[str, str, Path]]:
    """Check a single file against the registry.
    Returns list of (key_type, key_value, conflicting_path) tuples.
    """
    fm = parse_frontmatter(candidate)
    conflicts = []

    pmid = fm.get("pmid")
    if pmid and pmid in registry["pmid"]:
        for existing in registry["pmid"][pmid]:
            if existing != candidate:
                conflicts.append(("PMID", pmid, existing))

    doi = fm.get("doi")
    if doi:
        doi_lower = doi.lower()
        if doi_lower in registry["doi"]:
            for existing in registry["doi"][doi_lower]:
                if existing != candidate:
                    already_flagged = any(c[2] == existing for c in conflicts)
                    if not already_flagged:
                        conflicts.append(("DOI", doi, existing))

    return conflicts


def find_all_duplicates(registry: dict) -> list[tuple[str, str, list[Path]]]:
    """Find all groups in the registry that have more than one file."""
    dupes = []
    seen_paths: set[Path] = set()

    for pmid, paths in registry["pmid"].items():
        if len(paths) > 1:
            dupes.append(("PMID", pmid, paths))
            seen_paths.update(paths)

    for doi, paths in registry["doi"].items():
        if len(paths) > 1:
            if not any(p in seen_paths for p in paths):
                dupes.append(("DOI", doi, paths))
                seen_paths.update(paths)

    for nt, entries in registry["title"].items():
        if len(entries) < 2:
            continue
        paths = [p for p, _ in entries]
        if any(p in seen_paths for p in paths):
            continue
        has_pmid = [p for p, has in entries if has]
        no_pmid = [p for p, has in entries if not has]
        if has_pmid and no_pmid:
            dupes.append(("title", nt[:50], paths))
            seen_paths.update(paths)

    return dupes


def print_stats(registry: dict):
    pmid_count = sum(1 for paths in registry["pmid"].values() if len(paths) == 1)
    doi_count = sum(1 for paths in registry["doi"].values() if len(paths) == 1)
    pmid_dupes = sum(1 for paths in registry["pmid"].values() if len(paths) > 1)
    doi_dupes = sum(1 for paths in registry["doi"].values() if len(paths) > 1)
    title_dupes = sum(
        1 for entries in registry["title"].values()
        if len(entries) > 1 and any(h for _, h in entries) and any(not h for _, h in entries)
    )
    total = len([f for f in VAULT_DIR.glob("*.md") if not f.name.startswith("_")])
    print(f"Registry stats ({datetime.now().strftime('%Y-%m-%d %H:%M')}):")
    print(f"  Vault files:        {total}")
    print(f"  Unique PMIDs:       {pmid_count}")
    print(f"  Unique DOIs:        {doi_count}")
    print(f"  PMID conflicts:     {pmid_dupes}")
    print(f"  DOI-only conflicts: {doi_dupes}")
    print(f"  Title conflicts:    {title_dupes}")


def pick_canonical(paths: list[Path]) -> tuple[Path, list[Path], str]:
    """Given a list of duplicate vault files, pick the best one to keep.

    Scoring tuple (sorted desc):
      (pmid_present, pmcid_grade, full_text, integrated, word_count, filename_len)

    Returns (keep, delete_list, signal_summary).
    """
    def score(p: Path) -> tuple:
        fm = parse_frontmatter(p)
        pmid_ok = bool(fm.get("pmid"))
        if pmid_ok:
            try:
                pmid_ok = int(fm["pmid"]) > 0
            except (TypeError, ValueError):
                pmid_ok = False
        pmcid_grade = fm.get("enrichment_status") == "pmcid"
        full_text = bool(fm.get("full_text"))
        integrated = bool(fm.get("integrated"))
        word_count = int(fm.get("body_word_count") or 0)
        return (
            int(pmid_ok),
            int(pmcid_grade),
            int(full_text),
            int(integrated),
            word_count,
            len(p.stem),
        )

    scored = [(p, score(p)) for p in paths]
    scored.sort(key=lambda t: t[1], reverse=True)
    keep_p, keep_score = scored[0]
    losers = [p for p, _ in scored[1:]]

    labels = ("pmid", "pmcid", "full_text", "integrated", "word_count", "filename_len")
    runner_score = scored[1][1] if len(scored) > 1 else (0,) * len(labels)
    tie_break = "all-equal"
    for label, k, r in zip(labels, keep_score, runner_score):
        if k != r:
            tie_break = f"{label}={k}>{r}"
            break
    return keep_p, losers, tie_break


def auto_resolve_duplicates(registry: dict, dry_run: bool = False) -> int:
    """Auto-delete duplicate vault files, keeping the best copy. Returns count removed."""
    dupes = find_all_duplicates(registry)
    if not dupes:
        print("No duplicates to resolve.")
        return 0

    removed = 0
    for key_type, key_val, paths in dupes:
        keep, delete_list, tie_break = pick_canonical(paths)
        for victim in delete_list:
            if dry_run:
                print(f"  WOULD DELETE: {victim.name}  (keeping {keep.name}, matched by {key_type}={key_val}, tie-break: {tie_break})")
            else:
                victim.unlink()
                print(f"  DELETED: {victim.name}  (keeping {keep.name}, matched by {key_type}={key_val}, tie-break: {tie_break})")
                removed += 1

    if not dry_run and removed:
        print(f"Resolved {removed} duplicate(s).")
    return removed


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Detect duplicate papers in the vault")
    parser.add_argument("files", nargs="*", type=Path, help="Files to check")
    parser.add_argument("--all", action="store_true", help="Report all duplicates in vault")
    parser.add_argument("--stats", action="store_true", help="Print registry statistics")
    parser.add_argument("--auto-resolve", action="store_true",
                        help="Auto-delete duplicates, keeping the best copy")
    args = parser.parse_args()

    if args.stats:
        registry = build_registry()
        print_stats(registry)
        return 0

    if args.auto_resolve:
        registry = build_registry()
        print_stats(registry)
        auto_resolve_duplicates(registry)
        return 0

    if args.all:
        registry = build_registry()
        print_stats(registry)
        dupes = find_all_duplicates(registry)
        if not dupes:
            print("\nNo duplicates found.")
            return 0
        print(f"\n{len(dupes)} duplicate group(s) found:")
        for key_type, key_val, paths in dupes:
            print(f"\n  {key_type}: {key_val}")
            for p in paths:
                fm = parse_frontmatter(p)
                title = (fm.get("title") or "")[:60]
                print(f"    {p.name}  [{title}]")
        return 1

    if not args.files:
        parser.print_help()
        return 0

    candidates = [Path(f) for f in args.files]
    missing = [f for f in candidates if not f.exists()]
    if missing:
        for f in missing:
            print(f"ERROR: File not found: {f}", file=sys.stderr)
        return 2

    registry = build_registry(exclude=set(candidates))

    found_any = False
    for candidate in candidates:
        conflicts = check_file(candidate, registry)
        if conflicts:
            found_any = True
            fm = parse_frontmatter(candidate)
            title = (fm.get("title") or candidate.stem)[:60]
            print(f"DUPLICATE: {candidate.name}")
            print(f"  Title: {title}")
            for key_type, key_val, existing in conflicts:
                print(f"  {key_type} {key_val} already in: {existing.name}")
        else:
            print(f"OK: {candidate.name}")

    return 1 if found_any else 0


if __name__ == "__main__":
    sys.exit(main())
