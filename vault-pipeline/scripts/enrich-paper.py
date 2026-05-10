#!/usr/bin/env python3
"""
enrich-paper.py — Tier 2: enrich vault YAML frontmatter using PubMed metadata.

Searches PubMed for each vault file, fetches canonical metadata (title, authors,
journal, DOI, MeSH terms, abstract), and updates frontmatter. Preserves all
manually-curated fields: key_findings (unless empty), lab, type, related_papers.

PubMed search strategy (in order of reliability):
    1. Existing PMID in frontmatter -> fetch directly
    2. DOI in frontmatter -> DOI field lookup
    3. First author + first page number  (most reliable text search)
    4. First author + year + title keywords (fallback)

Every match is verified by checking that the PubMed title appears in the body
text — uncertain matches are rejected. False negatives are always preferable
to false positives in this enrichment step.

Usage:
    python enrich-paper.py FILE [FILE ...]   # Enrich specific files
    python enrich-paper.py --all             # All files missing PMID
    python enrich-paper.py --dry-run FILE    # Preview changes without writing
    python enrich-paper.py --force FILE      # Re-fetch even if PMID present

Required env: VAULT_DIR. Optional: LOG_DIR (default /tmp).
"""

import argparse
import json
import os
import re
import sys
import time
import datetime
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import urlencode
from urllib.error import URLError
import xml.etree.ElementTree as ET

# ── Configuration ──────────────────────────────────────────────────────────────

VAULT_DIR = Path(os.environ.get("VAULT_DIR") or sys.exit("ERROR: VAULT_DIR not set in environment")).expanduser()
LOG_DIR = Path(os.environ.get("LOG_DIR", "/tmp")).expanduser()
LOG_FILE = LOG_DIR / "enrich-paper.log"
NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
RATE_LIMIT_DELAY = 0.4   # stay under 3 req/sec (NCBI limit without API key)
SIMILARITY_THRESHOLD = 0.60

GENERIC_MESH = {
    "Animals", "Mice", "Rats", "Humans", "Male", "Female", "Adult",
    "Middle Aged", "Aged", "Young Adult", "Adolescent", "Child", "Infant",
    "Mice, Inbred C57BL", "Mice, Knockout", "Mice, Transgenic",
    "Disease Models, Animal", "Rats, Sprague-Dawley", "Rats, Wistar",
    "Cells, Cultured", "Random Allocation", "Time Factors", "Body Weight",
    "Body Mass Index", "Dose-Response Relationship, Drug",
}

PRESERVE_IF_NONEMPTY = {"key_findings", "related_papers", "lab", "type", "full_text",
                        "tags", "integrated"}

FIELD_ORDER = [
    "pmid", "pmcid", "title", "authors", "year", "journal",
    "volume", "issue", "pages", "doi", "type", "lab", "full_text",
    "enrichment_status", "subtopics", "key_findings", "related_papers",
]

JUNK_TITLE_PATTERNS = [
    r'^research\s+article',
    r'^original\s+article',
    r'^review\s+article',
    r'^techniques\s+and\s+resources',
    r'^basic\s+science',
    r'^brief\s+communication',
    r'^short\s+communication',
    r'^letter\s+to\s+the\s+editor',
    r'^editorial',
    r'^commentary',
    r'^perspective',
    r'^open\s+access',
    r'^clinical\s*[-–]\s*',
    r'^glyph',
    r'^\*?for\s+correspondence',
    r'^https?://',
    r'^doi:',
]

KNOWN_JOURNALS = {
    "gastroenterology", "hepatology", "diabetes", "obesity", "nature",
    "science", "cell", "lancet", "nejm", "pnas", "plos", "bmc",
    "metabolism", "endocrinology", "neuroscience", "appetite", "nutrients",
    "aging", "geroscience", "biorxiv", "medrxiv", "jci", "gut",
    "cellmetabolism", "cellreports", "naturemetabolism", "natureaging",
    "naturecommunications", "natureneuroscience", "molecularmetabolism",
    "agingcell",
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


# ── Frontmatter parsing ────────────────────────────────────────────────────────

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
    if fm.get("year") is not None:
        try:
            fm["year"] = int(str(fm["year"])[:4])
        except (ValueError, TypeError):
            pass
    if fm.get("pmid") is not None:
        fm["pmid"] = str(fm["pmid"])
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


# ── NCBI API ───────────────────────────────────────────────────────────────────

def ncbi_get(endpoint, params):
    url = f"{NCBI_BASE}/{endpoint}?{urlencode(params)}"
    time.sleep(RATE_LIMIT_DELAY)
    try:
        with urlopen(url, timeout=20) as r:
            return r.read().decode("utf-8")
    except URLError as e:
        log(f"  Network error: {e}")
        return None


def search_pmids(query):
    data = ncbi_get("esearch.fcgi", {
        "db": "pubmed", "term": query, "retmode": "json", "retmax": 5,
    })
    if not data:
        return []
    try:
        return json.loads(data)["esearchresult"]["idlist"]
    except Exception:
        return []


def fetch_article(pmid):
    data = ncbi_get("efetch.fcgi", {"db": "pubmed", "id": pmid, "retmode": "xml"})
    if not data:
        return None
    try:
        root = ET.fromstring(data)
        article = root.find(".//PubmedArticle")
        return _parse_xml(article) if article is not None else None
    except ET.ParseError as e:
        log(f"  XML parse error: {e}")
        return None


def _parse_xml(article):
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


# ── Title matching ─────────────────────────────────────────────────────────────

def title_similarity(t1, t2):
    stop = {"a", "an", "the", "of", "in", "for", "and", "or", "is", "to",
            "by", "on", "at", "its", "with", "from", "that", "this", "not",
            "are", "was", "as", "it", "be", "into", "via", "but"}
    w1 = {w for w in re.findall(r'\b[a-z]{2,}\b', t1.lower()) if w not in stop}
    w2 = {w for w in re.findall(r'\b[a-z]{2,}\b', t2.lower()) if w not in stop}
    if not w1 or not w2:
        return 0.0
    return len(w1 & w2) / max(len(w1), len(w2))


def title_in_body(pubmed_title, body):
    """Check if the PubMed title appears in the markdown body text."""
    if not pubmed_title or not body:
        return False
    body_norm = re.sub(r'\s+', ' ', body.lower())
    title_norm = re.sub(r'\s+', ' ', pubmed_title.lower()).strip().rstrip(".")
    if title_norm in body_norm:
        return True
    words = [w for w in re.findall(r'[a-z]{3,}', title_norm)]
    if len(words) < 3:
        return False
    threshold = int(len(words) * 0.8)
    window_size = max(len(title_norm) * 3, 300)
    for i in range(0, len(body_norm) - 50, 50):
        chunk = body_norm[i:i + window_size]
        hits = sum(1 for w in words if w in chunk)
        if hits >= threshold:
            return True
    return False


def confirm_match(fm, art, strategy, body=""):
    """Verify a PubMed candidate is the correct paper.

    Policy: reject if there is any doubt. Unenriched is always preferable to
    a false positive that leads to wrong citations.
    """
    pubmed_title = art.get("title", "")
    if not pubmed_title:
        return False

    body_hit = body and title_in_body(pubmed_title, body)
    vault_title = str(fm.get("title", ""))
    fm_sim = title_similarity(vault_title, pubmed_title) if vault_title else 0.0

    MIN_TITLE_WORDS = 6
    if body_hit:
        stop = {"a", "an", "the", "of", "in", "for", "and", "or", "is", "to",
                "by", "on", "at", "its", "with", "from", "that", "this", "not"}
        content_words = [w for w in re.findall(r'\b[a-z]{2,}\b', pubmed_title.lower())
                         if w not in stop]
        if len(content_words) >= MIN_TITLE_WORDS:
            return True
        pubmed_authors = art.get("authors", [])
        body_lower = body.lower() if body else ""
        for author in pubmed_authors[:5]:
            last = author.split()[-1].lower().rstrip(".")
            if len(last) >= 3 and last in body_lower:
                return True
        log(f"  Short title ({len(content_words)} content words) — no author confirmed in body")
        log(f"    pubmed: {pubmed_title[:70]}")
        return False

    if strategy == "doi" and fm_sim >= SIMILARITY_THRESHOLD:
        log(f"  Body text miss but DOI + title similarity OK (sim={fm_sim:.2f})")
        return True

    if vault_title:
        log(f"  REJECTED (sim={fm_sim:.2f}) [{strategy}] — title not confirmed in body text")
        log(f"    vault:  {vault_title[:70]}")
        log(f"    pubmed: {pubmed_title[:70]}")
    else:
        log(f"  REJECTED [{strategy}] — title not found in body text, no frontmatter title")
        log(f"    pubmed: {pubmed_title[:70]}")
    return False


# ── Search strategy ────────────────────────────────────────────────────────────

def is_suspicious_title(title):
    if not title or not title.strip():
        return True
    t = title.strip()
    if len(t) < 15:
        return True
    for pat in JUNK_TITLE_PATTERNS:
        if re.match(pat, t, re.IGNORECASE):
            return True
    if "GLYPH" in t or "͸" in t or "͵" in t:
        return True
    return False


def year_from_filename(filepath):
    stem = Path(filepath).stem
    m = re.search(r'((?:19|20)\d{2})', stem)
    return int(m.group(1)) if m else None


def best_year(fm, filepath):
    """Return the most trustworthy year: filename > frontmatter."""
    fn_year = year_from_filename(filepath)
    fm_year = fm.get("year")
    if fn_year:
        return fn_year
    if fm_year and isinstance(fm_year, int) and 1950 <= fm_year <= 2030:
        return fm_year
    return None


def first_page(pages_str):
    m = re.match(r'(\d+)', str(pages_str or ""))
    return m.group(1) if m else ""


def first_author_last(fm, filepath):
    authors = fm.get("authors", [])
    if authors:
        return str(authors[0]).split()[-1].rstrip(".")
    stem = Path(filepath).stem
    parts = stem.split("_")
    name_parts = []
    for p in parts:
        if re.match(r'^(19|20)\d{2}$', p):
            break
        if re.match(r'^[A-Z]{2,}$', p) or re.search(r'\d', p):
            break
        name_parts.append(p)
        if len(name_parts) > 1 and p[0].isupper():
            break
    candidate = " ".join(name_parts) if name_parts else ""
    if candidate.lower().replace("-", "").replace(" ", "") in KNOWN_JOURNALS:
        log(f"  Filename starts with journal name '{candidate}', not author")
        return ""
    return candidate


def find_pubmed_record(fm, filepath, body="", force=False):
    """Locate PubMed record. Returns (article_dict, strategy) or (None, reason)."""
    if fm.get("pmid") and not force:
        log(f"  Already has PMID {fm['pmid']} — skipping (use --force to refresh)")
        return None, "already_enriched"

    if fm.get("pmid") and force:
        log(f"  Force-fetching PMID {fm['pmid']}")
        art = fetch_article(str(fm["pmid"]))
        if art:
            return art, "pmid"

    if fm.get("doi"):
        doi = str(fm["doi"]).strip()
        log(f"  Trying DOI: {doi}")
        pmids = search_pmids(f"{doi}[aid]")
        if pmids:
            art = fetch_article(pmids[0])
            if art and confirm_match(fm, art, "doi", body):
                return art, "doi"

    author = first_author_last(fm, filepath)
    year = best_year(fm, filepath)
    pages = first_page(fm.get("pages", ""))
    title = str(fm.get("title", ""))

    title_usable = not is_suspicious_title(title)
    if not title_usable:
        if title:
            log(f"  Suspicious title ignored: {title[:60]}")
        title = ""

    if not title and body:
        for line in body.strip().split("\n")[:30]:
            stripped = line.strip().lstrip("#").strip()
            if stripped and len(stripped) > 15 and not stripped.startswith("<!--"):
                if not is_suspicious_title(stripped):
                    title = stripped
                    log(f"  Using title from body: {title[:70]}")
                    break

    if author and pages:
        query = f"{author}[auth] {pages}[pg]"
        log(f"  Trying author+page: {query}")
        pmids = search_pmids(query)
        for pmid in pmids[:3]:
            art = fetch_article(pmid)
            if art and confirm_match(fm, art, "author+page", body):
                return art, "author+page"

    stop = {"a", "an", "the", "of", "in", "for", "and", "or", "is", "to",
            "by", "on", "at", "with", "from"}
    keywords = [w for w in re.findall(r'\b[a-zA-Z]{4,}\b', title)
                if w.lower() not in stop][:4]
    if author and keywords:
        query = f"{author}[auth] {' '.join(keywords)}"
        if year:
            query += f" {year}[pdat]"
        log(f"  Trying author+keywords: {query}")
        pmids = search_pmids(query)
        for pmid in pmids[:3]:
            art = fetch_article(pmid)
            if art and confirm_match(fm, art, "author+keywords", body):
                return art, "author+keywords"

    if len(keywords) >= 3:
        query = " ".join(keywords)
        if year:
            query += f" {year}[pdat]"
        log(f"  Trying title keywords: {query}")
        pmids = search_pmids(query)
        for pmid in pmids[:3]:
            art = fetch_article(pmid)
            if art and confirm_match(fm, art, "title", body):
                return art, "title"

    if author and year:
        query = f"{author}[auth] {year}[pdat]"
        log(f"  Trying filename-only: {query}")
        pmids = search_pmids(query)
        for pmid in pmids[:5]:
            art = fetch_article(pmid)
            if art and confirm_match(fm, art, "filename", body):
                return art, "filename"

    if author and not year:
        query = f"{author}[auth]"
        log(f"  Trying author-only: {query}")
        pmids = search_pmids(query)
        for pmid in pmids[:5]:
            art = fetch_article(pmid)
            if art and confirm_match(fm, art, "author-only", body):
                return art, "author-only"

    return None, "not_found"


def findings_from_abstract(abstract, n=4):
    if not abstract:
        return []
    sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', abstract)
                 if len(s.strip()) > 40]
    if not sentences:
        return []
    finding_words = {
        "showed", "demonstrated", "found", "identified", "reveal", "required",
        "increased", "decreased", "reduced", "enhanced", "suppressed",
        "activated", "inhibited", "suggest", "indicate", "conclude",
        "significantly", "potently", "robustly", "unexpectedly",
    }
    scored = sorted(range(len(sentences)),
                    key=lambda i: sum(1 for w in sentences[i].lower().split()
                                      if w in finding_words),
                    reverse=True)
    top = sorted(scored[:n])
    return [sentences[i] for i in top]


def merge_pubmed(fm, art):
    fm = dict(fm)
    changes = []

    def update(key, new_val, note=None):
        if new_val is None or new_val == "":
            return
        old = fm.get(key)
        if key in PRESERVE_IF_NONEMPTY and old:
            return
        if new_val != old:
            fm[key] = new_val
            label = note or key
            changes.append(f"{label}: {str(old)[:35]!r} -> {str(new_val)[:35]!r}")

    update("pmid",    art.get("pmid"))
    update("pmcid",   art.get("pmcid"))
    update("title",   art.get("title"))
    update("authors", art.get("authors"))
    update("doi",     art.get("doi"))
    update("year",    art.get("year"))
    update("journal", art.get("journal"))
    update("volume",  art.get("volume") or None)
    update("issue",   art.get("issue") or None)
    update("pages",   art.get("pages") or None)

    mesh = art.get("mesh_terms", [])
    existing = fm.get("subtopics", [])
    if isinstance(existing, str):
        existing = [existing]
    mesh_lower = {t.lower() for t in mesh}
    extra = [t for t in existing if t.lower() not in mesh_lower]
    merged = (mesh + extra)[:12]
    if merged and merged != existing:
        fm["subtopics"] = merged
        changes.append(f"subtopics: {len(mesh)} MeSH + {len(extra)} existing = {len(merged)} total")

    kf = fm.get("key_findings", [])
    if (not kf or kf == []) and art.get("abstract"):
        sentences = findings_from_abstract(art["abstract"])
        if sentences:
            fm["key_findings"] = sentences
            changes.append(f"key_findings: {len(sentences)} sentences from abstract (was empty)")

    fm["enrichment_status"] = "pubmed"

    return fm, changes


def enrich_file(filepath, dry_run=False, force=False):
    filepath = Path(filepath)
    log(f"\n{'[DRY RUN] ' if dry_run else ''}-- {filepath.name}")

    text = filepath.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(text)

    if not fm:
        log("  No frontmatter -- skipping")
        return "skipped"

    if fm.get("type") == "grant":
        log("  Grant file -- skipping PubMed lookup")
        return "skipped"

    art, strategy = find_pubmed_record(fm, filepath, body=body, force=force)

    if strategy == "already_enriched":
        return "skipped"

    if art is None:
        log(f"  No PubMed match ({strategy})")
        # Don't stamp `enrichment_status: failed` for papers where "no PubMed
        # match" is the expected state, not a failure:
        #   - papers already enriched by Tier 3 (status=llm)
        #   - in-press papers without a PMID — once published, a future cycle
        #     will find the PMID and stamp success. Stamping `failed` triggers
        #     a hash-changing frontmatter write every night, leading to a
        #     librarian re-flag and embedding-cost churn.
        if fm.get("enrichment_status") == "llm":
            return "failed"
        if fm.get("status") == "in-press":
            log("  in-press paper without PMID — not stamping failed (will retry on next cycle)")
            return "failed"
        fm["enrichment_status"] = "failed"
        filepath.write_text(write_frontmatter(fm, body), encoding="utf-8")
        log("  Set enrichment_status: failed")
        return "failed"

    log(f"  Match [{strategy}] PMID {art.get('pmid')}: {art.get('title', '')[:65]}")

    updated_fm, changes = merge_pubmed(fm, art)

    if not changes:
        log("  No changes needed")
        return "skipped"

    for c in changes:
        log(f"  + {c}")

    if dry_run:
        log("  [DRY RUN] Not written")
        return "skipped"

    filepath.write_text(write_frontmatter(updated_fm, body), encoding="utf-8")
    log("  Saved")
    return "enriched"


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", help=".md files to process")
    parser.add_argument("--all", action="store_true", help="All vault files missing PMID")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    parser.add_argument("--force", action="store_true", help="Re-fetch even if PMID already present")
    args = parser.parse_args()

    if args.all:
        targets = sorted(f for f in VAULT_DIR.glob("*.md") if not f.name.startswith("_"))
        if not args.force:
            def needs_enrichment(p):
                fm, _ = parse_frontmatter(p.read_text(encoding="utf-8"))
                # Skip preprint and in-review papers — handled by sibling scripts
                if fm.get("status") in ("preprint", "in-review"):
                    return False
                if not fm.get("pmid"):
                    return True
                if fm.get("enrichment_status") == "failed":
                    return True
                return False
            targets = [f for f in targets if needs_enrichment(f)]
        log(f"Processing {len(targets)} files")
    elif args.files:
        targets = [Path(f) for f in args.files]
    else:
        parser.print_help()
        sys.exit(1)

    counts = {"enriched": 0, "skipped": 0, "failed": 0}
    failed = []

    for f in targets:
        if not f.exists():
            log(f"Not found: {f}")
            counts["failed"] += 1
            continue
        result = enrich_file(f, dry_run=args.dry_run, force=args.force)
        counts[result] += 1
        if result == "failed":
            failed.append(f.name)

    log(f"\n{'='*60}")
    log(f"Enriched: {counts['enriched']} | Skipped: {counts['skipped']} | "
        f"Failed: {counts['failed']}")
    if failed:
        log(f"No match: {', '.join(failed)}")


if __name__ == "__main__":
    main()
