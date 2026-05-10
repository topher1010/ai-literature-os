#!/usr/bin/env python3
"""
parse-endnote.py — Extract PMIDs from an Endnote XML export.

Parses the Endnote XML format and extracts PMIDs from:
  1. <accession-num> field (primary — Endnote stores PMID here)
  2. PubMed URL in <url> fields (fallback)

Output files (in --output-dir, default /tmp):
  endnote_pmids.txt    — One PMID per line (ready for add-paper.py --file)
  endnote_no_pmid.txt  — Papers without PMIDs (for manual lookup)

Usage:
    python parse-endnote.py library.xml
    python parse-endnote.py --stats-only library.xml
    python parse-endnote.py --vault-dir /path/to/vault library.xml

If --vault-dir is omitted, $VAULT_DIR from the environment is used.
"""

import argparse
import os
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def get_text(el, path):
    """Get text from an element, handling Endnote's <style> wrappers."""
    if el is None:
        return ""
    node = el.find(path + "/style") if el.find(path + "/style") is not None else el.find(path)
    return (node.text or "").strip() if node is not None else ""


def parse_record(rec):
    """Parse a single <record> element. Returns dict."""
    out = {}

    out["ref_type"] = rec.find(".//ref-type").get("name", "") if rec.find(".//ref-type") is not None else ""
    out["title"] = get_text(rec, ".//titles/title")
    out["journal"] = get_text(rec, ".//titles/secondary-title") or get_text(rec, ".//periodical/full-title")
    out["year"] = get_text(rec, ".//dates/year")
    out["volume"] = get_text(rec, ".//volume")
    out["pages"] = get_text(rec, ".//pages")

    authors = []
    for au in rec.findall(".//contributors/authors/author"):
        style = au.find("style")
        name = (style.text if style is not None else au.text) or ""
        if name.strip():
            authors.append(name.strip())
    out["authors"] = authors

    acc = get_text(rec, ".//accession-num")
    if acc.isdigit():
        out["pmid"] = acc

    if "pmid" not in out:
        for url_el in rec.findall(".//url/style"):
            if url_el.text and "pubmed" in url_el.text:
                m = re.search(r"pubmed(?:\.gov)?/(\d+)", url_el.text)
                if m:
                    out["pmid"] = m.group(1)
                    break

    doi = get_text(rec, ".//electronic-resource-num")
    if doi and "10." in doi:
        out["doi"] = doi

    return out


def load_vault_pmids(vault_dir):
    """Load existing PMIDs from the vault."""
    pmids = set()
    for f in Path(vault_dir).glob("*.md"):
        if f.name.startswith("_"):
            continue
        m = re.search(r"^pmid:\s*(\d+)", f.read_text(errors="replace"), re.MULTILINE)
        if m:
            pmids.add(m.group(1))
    return pmids


def main():
    parser = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", help="Endnote XML export file")
    parser.add_argument("--output-dir", default="/tmp",
        help="Directory for output files (default: /tmp)")
    parser.add_argument("--stats-only", action="store_true",
        help="Print statistics without writing files")
    parser.add_argument("--vault-dir",
        default=os.environ.get("VAULT_DIR"),
        help="Vault directory (default: $VAULT_DIR)")
    args = parser.parse_args()

    if not args.vault_dir:
        sys.exit("ERROR: --vault-dir not given and VAULT_DIR not set in environment")

    inpath = Path(args.input)
    if not inpath.exists():
        print(f"Error: {inpath} not found", file=sys.stderr)
        sys.exit(1)

    tree = ET.parse(str(inpath))
    root = tree.getroot()
    records = root.findall(".//record")
    parsed = [parse_record(r) for r in records]

    print(f"Parsed {len(parsed)} records from {inpath.name}")

    with_pmid = [r for r in parsed if r.get("pmid")]
    without_pmid = [r for r in parsed if not r.get("pmid")]
    unique_pmids = sorted(set(r["pmid"] for r in with_pmid), key=lambda x: int(x))

    print(f"  With PMID: {len(with_pmid)} ({len(unique_pmids)} unique)")
    print(f"  Without PMID: {len(without_pmid)}")

    vault_pmids = load_vault_pmids(args.vault_dir)
    overlap = set(unique_pmids) & vault_pmids
    new_pmids = [p for p in unique_pmids if p not in vault_pmids]
    print(f"  Already in vault: {len(overlap)}")
    print(f"  New to vault: {len(new_pmids)}")

    decades = {}
    for r in parsed:
        yr = r.get("year", "")
        if yr.isdigit() and 1900 <= int(yr) <= 2030:
            decade = (int(yr) // 10) * 10
            decades[decade] = decades.get(decade, 0) + 1
    print("\n  Decade distribution:")
    for d in sorted(decades):
        print(f"    {d}s: {decades[d]}")

    if without_pmid:
        print(f"\n  Papers without PMID:")
        for r in without_pmid:
            doi = r.get("doi", "")
            doi_str = f" [DOI:{doi}]" if doi else ""
            print(f"    {r.get('year', '?')}: {r.get('title', '?')[:80]}{doi_str}")

    if args.stats_only:
        return

    outdir = Path(args.output_dir)

    pmid_file = outdir / "endnote_pmids.txt"
    with open(pmid_file, "w") as f:
        for pmid in new_pmids:
            f.write(pmid + "\n")
    print(f"\nWrote {len(new_pmids)} PMIDs to {pmid_file}")

    no_pmid_file = outdir / "endnote_no_pmid.txt"
    with open(no_pmid_file, "w") as f:
        for r in without_pmid:
            author = "; ".join(r.get("authors", ["?"]))
            year = r.get("year", "?")
            title = r.get("title", "?")
            doi = r.get("doi", "")
            line = f"{author}\t{year}\t{title}"
            if doi:
                line += f"\tDOI:{doi}"
            f.write(line + "\n")
    print(f"Wrote {len(without_pmid)} no-PMID records to {no_pmid_file}")


if __name__ == "__main__":
    main()
