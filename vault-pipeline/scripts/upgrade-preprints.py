#!/usr/bin/env python3
"""
upgrade-preprints.py — Nightly check: have any preprints been formally published?

Finds vault papers with status: preprint, queries PubMed to see if a published
version now exists (via PMID lookup or title search), and upgrades the file
with published metadata + PMC full text when available.

Detection strategy:
  1. If the preprint already has a PMID → check PubMed for updated journal info
     (BioRxiv preprints deposited on PMC get a PMID that later links to the
     published version).
  2. If no PMID → search PubMed by title + first author to find the published
     version.

When a published version is found:
  - Update journal, volume, issue, pages, DOI, PMID, PMCID
  - Set status from "preprint" to removed (standard published paper)
  - Fetch PMC full text if available (upgrade body)
  - Preserve existing tags, key_findings, related_papers, integrated date

Run via sync-vault.sh. Processes up to --batch N papers per run.

Usage:
    python upgrade-preprints.py --all           # Check all preprints
    python upgrade-preprints.py --batch 5       # Limit to N per run
    python upgrade-preprints.py --dry-run --all # Preview without writing

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
LOG_FILE = LOG_DIR / "upgrade-preprints.log"
NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
RATE_LIMIT_DELAY = 0.4

PREPRINT_JOURNALS = {
    "biorxiv", "medrxiv", "arxiv", "preprints",
    "biorxiv : the preprint server for biology",
    "medrxiv : the preprint server for health sciences",
    "research square",
}

FIELD_ORDER = [
    "pmid", "pmcid", "title", "authors", "year", "journal",
    "volume", "issue", "pages", "doi", "type", "lab", "full_text",
    "enrichment_status", "status", "subtopics", "key_findings",
    "related_papers", "tags", "integrated",
]

GENERIC_MESH = {
    "Animals", "Mice", "Rats", "Humans", "Male", "Female", "Adult",
    "Middle Aged", "Aged", "Young Adult", "Adolescent", "Child", "Infant",
    "Mice, Inbred C57BL", "Mice, Knockout", "Mice, Transgenic",
    "Disease Models, Animal", "Rats, Sprague-Dawley", "Rats, Wistar",
    "Cells, Cultured", "Random Allocation", "Time Factors", "Body Weight",
    "Body Mass Index", "Dose-Response Relationship, Drug",
}


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
    elif key == "tags":
        if isinstance(val, list) and val:
            items = ", ".join(f'"{t}"' for t in val)
            lines.append(f"tags: [{items}]")
        else:
            lines.append(f"tags: []")
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


def fetch_pubmed_by_pmid(pmid):
    data = ncbi_get("efetch.fcgi", {"db": "pubmed", "id": pmid, "retmode": "xml"})
    if not data:
        return None
    try:
        root = ET.fromstring(data)
        article = root.find(".//PubmedArticle")
        return _parse_pubmed_xml(article) if article is not None else None
    except ET.ParseError:
        return None


def search_pubmed_for_published(title, first_author_last):
    clean_title = re.sub(r'["\[\]{}()]', '', title).strip()
    title_words = clean_title.split()[:12]
    title_query = " ".join(title_words)

    query = f'{title_query}[Title] AND {first_author_last}[Author]'
    data = ncbi_get("esearch.fcgi", {
        "db": "pubmed", "term": query, "retmax": 5, "retmode": "xml",
    })
    if not data:
        return None

    try:
        root = ET.fromstring(data)
        id_list = root.find("IdList")
        if id_list is None:
            return None
        pmids = [el.text for el in id_list.findall("Id") if el.text]
        if not pmids:
            return None

        for pmid in pmids:
            art = fetch_pubmed_by_pmid(pmid)
            if art and not _is_preprint_journal(art.get("journal", "")):
                return pmid
        return None
    except ET.ParseError:
        return None


def _is_preprint_journal(journal):
    return journal.lower().strip() in PREPRINT_JOURNALS


def _parse_pubmed_xml(article):
    out = {}

    pmid_el = article.find(".//PMID")
    out["pmid"] = pmid_el.text if pmid_el is not None else None

    title_el = article.find(".//ArticleTitle")
    if title_el is not None:
        out["title"] = "".join(title_el.itertext()).strip().rstrip(".")

    abstract_els = article.findall(".//AbstractText")
    out["abstract"] = " ".join("".join(el.itertext()) for el in abstract_els).strip()

    authors = []
    for author in article.findall(".//Author"):
        last = author.findtext("LastName", "")
        fore = author.findtext("ForeName", "")
        if not last:
            collective = author.findtext("CollectiveName", "")
            if collective:
                authors.append(collective)
            continue
        if fore and fore[-1].isalpha() and (len(fore) <= 2 or fore[-2] == " "):
            fore += "."
        authors.append(f"{fore} {last}".strip() if fore else last)
    out["authors"] = authors

    journal_el = article.find(".//Journal")
    if journal_el is not None:
        out["journal"] = journal_el.findtext("Title", "")
        ji = journal_el.find(".//JournalIssue")
        if ji is not None:
            out["volume"] = ji.findtext("Volume") or ""
            out["issue"] = ji.findtext("Issue") or ""
            pd = ji.find("PubDate")
            if pd is not None:
                year_str = pd.findtext("Year") or pd.findtext("MedlineDate", "")[:4]
                out["year"] = int(year_str) if year_str.isdigit() else None

    out["pages"] = article.findtext(".//MedlinePgn") or ""

    id_list = article.find(".//PubmedData/ArticleIdList")
    if id_list is None:
        id_list = article.find(".//ArticleIdList")
    if id_list is not None:
        for id_el in id_list.findall("ArticleId"):
            if id_el.get("IdType") == "doi":
                out["doi"] = id_el.text
            elif id_el.get("IdType") == "pmc":
                out["pmcid"] = id_el.text

    major, minor = [], []
    for heading in article.findall(".//MeshHeading"):
        desc = heading.find("DescriptorName")
        if desc is None or desc.text in GENERIC_MESH:
            continue
        (major if desc.get("MajorTopicYN") == "Y" else minor).append(desc.text)
    out["mesh_terms"] = (major + minor)[:10]

    return out


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
            elif tag in ("fig", "table-wrap"):
                continue
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


def upgrade_preprint(filepath, dry_run=False):
    filepath = Path(filepath)
    log(f"\n-- {filepath.name}")

    text = filepath.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(text)

    if not fm:
        log("  No frontmatter — skipping")
        return "skipped"

    if fm.get("status") != "preprint":
        log(f"  Status is {fm.get('status')!r} — skipping")
        return "skipped"

    title = fm.get("title", "")
    pmid = fm.get("pmid")
    authors = fm.get("authors", [])

    first_author_last = ""
    if authors:
        first_author_last = str(authors[0]).split()[-1].rstrip(".")

    published_art = None
    if pmid:
        log(f"  Has PMID {pmid} — checking PubMed for publication status...")
        art = fetch_pubmed_by_pmid(pmid)
        if art:
            journal = art.get("journal", "")
            if not _is_preprint_journal(journal):
                log(f"  Published! Journal: {journal}")
                published_art = art
            else:
                log(f"  Still listed as preprint ({journal})")
                return "skipped"
        else:
            log(f"  PubMed fetch failed")

    if not published_art and title and first_author_last:
        log(f"  Searching PubMed: {first_author_last} + \"{title[:50]}...\"")
        found_pmid = search_pubmed_for_published(title, first_author_last)
        if found_pmid:
            log(f"  Found published version: PMID {found_pmid}")
            published_art = fetch_pubmed_by_pmid(found_pmid)
        else:
            log(f"  No published version found yet")
            return "skipped"

    if not published_art:
        return "skipped"

    new_pmid = published_art.get("pmid")
    new_pmcid = published_art.get("pmcid")
    new_journal = published_art.get("journal", "")
    new_doi = published_art.get("doi", "")
    new_year = published_art.get("year")

    log(f"  Upgrading: {new_journal} ({new_year})")
    log(f"    PMID: {new_pmid}, DOI: {new_doi}")

    if dry_run:
        log(f"  [DRY RUN] Would upgrade to published status")
        return "upgraded"

    fm["pmid"] = new_pmid or fm.get("pmid")
    fm["pmcid"] = new_pmcid or fm.get("pmcid")
    fm["journal"] = new_journal
    fm["doi"] = new_doi or fm.get("doi")
    if new_year:
        fm["year"] = new_year
    fm["volume"] = published_art.get("volume") or fm.get("volume")
    fm["issue"] = published_art.get("issue") or fm.get("issue")
    fm["pages"] = published_art.get("pages") or fm.get("pages")

    if published_art.get("authors"):
        fm["authors"] = published_art["authors"]

    mesh = published_art.get("mesh_terms", [])
    if mesh and not fm.get("subtopics"):
        fm["subtopics"] = mesh

    del fm["status"]

    new_body = body
    if new_pmcid:
        log(f"  Fetching PMC full text: {new_pmcid}")
        pmc_text = fetch_pmc_text(new_pmcid)
        pmc_has_body = pmc_text and pmc_text.count('\n## ') > 1
        if pmc_has_body:
            log(f"  PMC full text: {len(pmc_text)} chars")
            fm["full_text"] = True
            fm["enrichment_status"] = "pmcid"
            new_body = "\n" + pmc_text + "\n"
        elif pmc_text:
            log(f"  PMC returned abstract-only — keeping existing body text")
            fm["enrichment_status"] = fm.get("enrichment_status", "pubmed")
        else:
            log(f"  PMC fetch failed — keeping existing body")
            fm["enrichment_status"] = fm.get("enrichment_status", "pubmed")
    else:
        fm["enrichment_status"] = "pubmed"

    filepath.write_text(write_frontmatter(fm, new_body), encoding="utf-8")
    log(f"  Upgraded to published status")
    return "upgraded"


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", help=".md files to check")
    parser.add_argument("--all", action="store_true", help="All preprint papers")
    parser.add_argument("--batch", type=int, default=0, help="Limit to N papers per run (0 = unlimited)")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()

    if not args.all and not args.files:
        parser.print_help()
        sys.exit(1)

    if args.all:
        targets = []
        for f in sorted(VAULT_DIR.glob("*.md")):
            if f.name.startswith("_"):
                continue
            fm, _ = parse_frontmatter(f.read_text(encoding="utf-8"))
            if fm.get("status") == "preprint":
                targets.append(f)
        if args.batch > 0:
            targets = targets[:args.batch]
        log(f"Found {len(targets)} preprints to check (batch={args.batch or 'all'})")
    else:
        targets = [Path(f) for f in args.files]

    counts = {"upgraded": 0, "skipped": 0, "failed": 0}
    for f in targets:
        if not f.exists():
            log(f"Not found: {f}")
            counts["failed"] += 1
            continue
        result = upgrade_preprint(f, dry_run=args.dry_run)
        counts[result] += 1

    log(f"\n{'='*60}")
    log(f"Upgraded: {counts['upgraded']} | Skipped: {counts['skipped']} | "
        f"Failed: {counts['failed']}")


if __name__ == "__main__":
    main()
