#!/usr/bin/env python3
"""
add-paper.py — PMID-first intake for the vault.

For each paper: fetches PubMed metadata → checks PMC for full text → creates
vault markdown file. Skips papers already in the vault (matched by PMID or DOI).

Enrichment status set on output:
  pmcid         — full text fetched from PMC (best)
  biorxiv       — full text fetched from BioRxiv JATS XML
  abstract-only — PubMed or RIS abstract only (PMC not available)

Usage:
    python add-paper.py 12345678 87654321      # One or more PMIDs
    python add-paper.py --ris papers.ris       # Import from RIS file
    python add-paper.py --ris file.ris 12345   # Mix RIS + explicit PMIDs
    python add-paper.py --dry-run --ris f.ris  # Preview without writing
    python add-paper.py --biorxiv https://www.biorxiv.org/content/10.1234/2026.01.01.123456v1
    python add-paper.py --biorxiv 10.1234/2026.01.01.123456  # DOI directly

Required env: VAULT_DIR.
Optional env: LOG_DIR (default: /tmp).
"""

import argparse
import datetime
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen

# ── Configuration ──────────────────────────────────────────────────────────────

VAULT_DIR = Path(os.environ.get("VAULT_DIR") or sys.exit("ERROR: VAULT_DIR not set in environment")).expanduser()
LOG_DIR = Path(os.environ.get("LOG_DIR", "/tmp")).expanduser()
LOG_FILE = LOG_DIR / "add-paper.log"
NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
BIORXIV_API = "https://api.biorxiv.org/details"
RATE_LIMIT_DELAY = 0.4   # stay under 3 req/sec

# MeSH terms too generic to be useful
GENERIC_MESH = {
    "Animals", "Mice", "Rats", "Humans", "Male", "Female", "Adult",
    "Middle Aged", "Aged", "Young Adult", "Adolescent", "Child", "Infant",
    "Mice, Inbred C57BL", "Mice, Knockout", "Mice, Transgenic",
    "Disease Models, Animal", "Rats, Sprague-Dawley", "Rats, Wistar",
    "Cells, Cultured", "Random Allocation", "Time Factors", "Body Weight",
    "Body Mass Index", "Dose-Response Relationship, Drug",
}

FIELD_ORDER = [
    "pmid", "pmcid", "title", "authors", "year", "journal",
    "volume", "issue", "pages", "doi", "type", "lab", "full_text",
    "enrichment_status", "status", "subtopics", "key_findings",
    "related_papers",
]


# ── Logging ────────────────────────────────────────────────────────────────────

def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass  # log dir may not exist; stdout still works


# ── RIS parsing ────────────────────────────────────────────────────────────────

def parse_ris(filepath):
    """Parse a RIS file. Returns list of dicts with keys: pmid, title, authors,
    abstract, year, doi, journal, volume, issue, pages, start_page, end_page."""
    records = []
    current = {}
    authors = []

    with open(filepath, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\r\n")
            m = re.match(r'^([A-Z0-9]{2})\s{1,2}-\s*(.*)', line)
            if not m:
                if current.get("_last_key") == "abstract" and line.startswith("   "):
                    current["abstract"] = current.get("abstract", "") + " " + line.strip()
                continue
            tag, val = m.group(1), m.group(2).strip()

            if tag == "TY":
                current = {"type_tag": val}
                authors = []
            elif tag == "ER":
                current["authors"] = authors
                if current.get("pmid") or current.get("doi") or current.get("title"):
                    records.append(current)
                current = {}
                authors = []
            elif tag == "AU":
                # Endnote exports as "Last, First" — convert to "First Last"
                # Some other sources export as "First Last" already
                if "," in val:
                    parts = [p.strip() for p in val.split(",", 1)]
                    val = f"{parts[1]} {parts[0]}" if parts[1] else parts[0]
                if val.lower() not in ("et al.", "et al"):
                    authors.append(val)
            elif tag in ("PM", "PMID", "AN"):
                if val.strip().isdigit():
                    current["pmid"] = val.strip()
            elif tag == "C2":
                pmcid_val = val.strip()
                if pmcid_val.startswith("PMC") or pmcid_val.isdigit():
                    current["pmcid_ris"] = pmcid_val
            elif tag == "TI":
                current["title"] = val
            elif tag == "AB":
                current["abstract"] = val
                current["_last_key"] = "abstract"
            elif tag == "PY":
                yr = val.split("/")[0].strip()
                if yr.isdigit():
                    current["year"] = int(yr)
            elif tag == "DO":
                current["doi"] = val
            elif tag in ("JO", "JF", "T2"):
                if not current.get("journal"):
                    current["journal"] = val
            elif tag == "VL":
                current["volume"] = val
            elif tag == "IS":
                current["issue"] = val
            elif tag == "SP":
                current["start_page"] = val
            elif tag == "EP":
                current["end_page"] = val
            elif tag == "SN":
                current["issn"] = val

    for rec in records:
        sp = rec.pop("start_page", "")
        ep = rec.pop("end_page", "")
        if sp and ep:
            rec["pages"] = f"{sp}-{ep}"
        elif sp:
            rec["pages"] = sp
        rec.pop("_last_key", None)
        rec.pop("type_tag", None)

    return records


# ── Vault index (dedup) ────────────────────────────────────────────────────────

def load_vault_index():
    """Return set of existing PMIDs and set of DOIs in the vault."""
    pmids = set()
    dois = set()
    for f in VAULT_DIR.glob("*.md"):
        if f.name.startswith("_"):
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        m = re.search(r'^pmid:\s*([0-9]+)', text, re.MULTILINE)
        if m:
            pmids.add(m.group(1).strip())
        m = re.search(r'^doi:\s*(.+)', text, re.MULTILINE)
        if m:
            dois.add(m.group(1).strip().lower())
    return pmids, dois


# ── NCBI API ───────────────────────────────────────────────────────────────────

def ncbi_get(endpoint, params):
    url = f"{NCBI_BASE}/{endpoint}?{urlencode(params)}"
    time.sleep(RATE_LIMIT_DELAY)
    try:
        with urlopen(url, timeout=30) as r:
            return r.read().decode("utf-8", errors="replace")
    except URLError as e:
        log(f"  Network error: {e}")
        return None


def fetch_pubmed(pmid):
    """Fetch and parse PubMed XML for a single PMID. Returns dict or None."""
    data = ncbi_get("efetch.fcgi", {"db": "pubmed", "id": pmid, "retmode": "xml"})
    if not data:
        return None
    try:
        root = ET.fromstring(data)
        article = root.find(".//PubmedArticle")
        return _parse_pubmed_xml(article) if article is not None else None
    except ET.ParseError as e:
        log(f"  XML parse error (PubMed): {e}")
        return None


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


# ── PMC full text ──────────────────────────────────────────────────────────────

def fetch_pmc_text(pmcid):
    """Fetch PMC full text as markdown. Returns string or None."""
    pmcid_num = re.sub(r'^PMC', '', str(pmcid))
    log(f"  Fetching PMC full text: PMC{pmcid_num}")
    data = ncbi_get("efetch.fcgi", {
        "db": "pmc", "id": pmcid_num, "retmode": "xml",
    })
    if not data:
        return None
    try:
        root = ET.fromstring(data)
        return _jats_to_markdown(root)
    except ET.ParseError as e:
        log(f"  XML parse error (PMC): {e}")
        return None


def _jats_to_markdown(root):
    """Convert JATS XML to readable markdown text."""
    parts = []

    def text_of(el, sep=" "):
        chunks = []
        if el.text:
            chunks.append(el.text.strip())
        for child in el:
            chunks.append(text_of(child, sep))
            if child.tail:
                chunks.append(child.tail.strip())
        return sep.join(c for c in chunks if c)

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


# ── BioRxiv / MedRxiv API ─────────────────────────────────────────────────────

def parse_biorxiv_input(raw):
    """Extract DOI and server (biorxiv/medrxiv) from a URL or bare DOI string."""
    raw = raw.strip().rstrip("/")
    m = re.match(
        r'https?://(?:www\.)?(biorxiv|medrxiv)\.org/content/(10\.\d+/[\d.]+?)(?:v\d+)?(?:\.full)?$',
        raw)
    if m:
        return m.group(2), m.group(1)
    m = re.match(r'https?://doi\.org/(10\.\d+/[\d.]+?)$', raw)
    if m:
        return m.group(1), "biorxiv"
    m = re.match(r'^(10\.\d+/[\d.]+)$', raw)
    if m:
        return m.group(1), "biorxiv"
    return None, None


def _abbreviate_author_name(name):
    """'Bailey A. Knopf' → 'B. A. Knopf'; 'Chen-Yu Yeh' → 'C.-Y. Yeh'."""
    parts = name.strip().split()
    if len(parts) < 2:
        return name
    last = parts[-1]
    out = []
    for p in parts[:-1]:
        p = p.rstrip(".")
        if not p:
            continue
        if "-" in p:
            subs = [s for s in p.split("-") if s]
            out.append("-".join(s[0].upper() + "." for s in subs))
        else:
            out.append(p[0].upper() + ".")
    return " ".join(out + [last])


def _meta_all(html, name):
    """Return all <meta name="..." content="..."> values (order preserved)."""
    return re.findall(
        rf'<meta\s+name="{re.escape(name)}"\s+content="([^"]*)"',
        html, flags=re.IGNORECASE,
    )


def _curl_get(url, timeout=30):
    """Fetch a URL via curl (used to bypass Cloudflare TLS fingerprinting
    on www.biorxiv.org, which rejects Python urllib regardless of headers).
    Returns decoded text on success, None on failure.
    """
    import subprocess
    try:
        r = subprocess.run(
            [
                "curl", "-sSL", "--fail",
                "-A", "Mozilla/5.0 (compatible; ai-literature-os/1.0)",
                "--max-time", str(timeout),
                url,
            ],
            capture_output=True, text=True, timeout=timeout + 5,
        )
        if r.returncode != 0:
            log(f"  curl error ({r.returncode}): {r.stderr.strip()[:200]}")
            return None
        return r.stdout
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        log(f"  curl exception: {e}")
        return None


def fetch_biorxiv_metadata_html(doi, server="biorxiv"):
    """Scrape metadata from the BioRxiv/MedRxiv HTML page's citation meta tags.

    Used as fallback when the JSON API at api.biorxiv.org returns "Not
    available at this time" — broken for many papers since early 2026.
    """
    url = f"https://www.{server}.org/content/{doi}v1"
    log(f"  Scraping {server} HTML: {url}")
    html = _curl_get(url)
    if html is None:
        return None

    title = (_meta_all(html, "citation_title") or [""])[0]
    if not title:
        log(f"  No citation_title in HTML — page may be a 404 or non-paper")
        return None

    raw_authors = _meta_all(html, "citation_author")
    authors = [_abbreviate_author_name(a) for a in raw_authors if a.strip()]

    pdf_url = (_meta_all(html, "citation_pdf_url") or [""])[0]
    pdf_date = ""
    pdf_date_m = re.search(r'/early/(\d{4})/(\d{2})/(\d{2})/', pdf_url)
    if pdf_date_m:
        pdf_date = f"{pdf_date_m.group(1)}-{pdf_date_m.group(2)}-{pdf_date_m.group(3)}"
    pub_date = (_meta_all(html, "citation_publication_date") or [""])[0]
    date_str = pdf_date or (pub_date.replace("/", "-") if pub_date else "")
    year = None
    if date_str:
        yr = date_str.split("-")[0]
        if yr.isdigit():
            year = int(yr)

    journal = (_meta_all(html, "citation_journal_title") or [server.capitalize()])[0]
    page_doi = (_meta_all(html, "citation_doi") or [doi])[0]

    dc_desc = _meta_all(html, "DC.Description")
    abstract = dc_desc[0] if dc_desc else ""

    pmids = _meta_all(html, "citation_pmid")
    pmid = pmids[0] if pmids else None

    section = (_meta_all(html, "citation_section") or [""])[0]

    slug = doi.split("/", 1)[-1] if "/" in doi else doi
    jatsxml = ""
    if date_str:
        dp = date_str.replace("-", "/")
        jatsxml = f"https://www.{server}.org/content/early/{dp}/{slug}.source.xml"

    return {
        "title":    title.rstrip("."),
        "authors":  authors,
        "year":     year,
        "journal":  journal or server.capitalize(),
        "doi":      page_doi,
        "abstract": abstract,
        "category": section,
        "server":   server,
        "jatsxml":  jatsxml,
        "version":  "1",
        "date":     date_str,
        "pmid":     pmid,
    }


def _biorxiv_api_dead(data):
    """Detect the 'API down' response shapes from api.biorxiv.org."""
    if not isinstance(data, dict):
        return False
    msgs = data.get("messages", [])
    if isinstance(msgs, list) and msgs:
        status = (msgs[0] or {}).get("status", "") if isinstance(msgs[0], dict) else ""
        if isinstance(status, str) and "not available" in status.lower():
            return True
    if isinstance(data.get("status"), str) and "not available" in data["status"].lower():
        return True
    return False


def fetch_biorxiv_metadata(doi, server="biorxiv"):
    """Fetch metadata from BioRxiv/MedRxiv content API, with HTML fallback."""
    url = f"{BIORXIV_API}/{server}/{doi}"
    log(f"  Fetching {server} API: {doi}")
    try:
        with urlopen(url, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8", errors="replace"))
    except (URLError, json.JSONDecodeError) as e:
        log(f"  {server} API error: {e}")
        if server == "biorxiv":
            log(f"  Retrying as medrxiv...")
            alt = fetch_biorxiv_metadata(doi, server="medrxiv")
            if alt:
                return alt
        log(f"  Falling back to HTML scrape for {server}")
        return fetch_biorxiv_metadata_html(doi, server)

    if _biorxiv_api_dead(data):
        log(f"  {server} API returned 'Not available at this time' — scraping HTML")
        html_art = fetch_biorxiv_metadata_html(doi, server)
        if html_art:
            return html_art
        if server == "biorxiv":
            log(f"  HTML scrape failed on biorxiv, trying medrxiv...")
            return fetch_biorxiv_metadata(doi, server="medrxiv")
        return None

    collection = data.get("collection", [])
    if not collection:
        if server == "biorxiv":
            log(f"  Not found on biorxiv, trying medrxiv...")
            alt = fetch_biorxiv_metadata(doi, server="medrxiv")
            if alt:
                return alt
        log(f"  No results from {server} API — falling back to HTML scrape")
        return fetch_biorxiv_metadata_html(doi, server)

    rec = collection[0]

    authors = []
    for auth_str in rec.get("authors", "").split(";"):
        auth_str = auth_str.strip().rstrip(".")
        if not auth_str:
            continue
        parts = [p.strip() for p in auth_str.split(",", 1)]
        if len(parts) == 2 and parts[1]:
            fore = parts[1].strip().rstrip(".")
            if fore and fore[-1].isalpha() and (len(fore) <= 2 or fore[-2] == " "):
                fore += "."
            authors.append(f"{fore} {parts[0]}")
        else:
            authors.append(parts[0])

    date_str = rec.get("date", "")
    year = None
    if date_str:
        yr = date_str.split("-")[0]
        if yr.isdigit():
            year = int(yr)

    return {
        "title":    rec.get("title", "").rstrip("."),
        "authors":  authors,
        "year":     year,
        "journal":  rec.get("server", server).capitalize(),
        "doi":      rec.get("doi", doi),
        "abstract": rec.get("abstract", ""),
        "category": rec.get("category", ""),
        "server":   rec.get("server", server),
        "jatsxml":  rec.get("jatsxml", ""),
        "version":  rec.get("version", "1"),
        "date":     date_str,
    }


def fix_biorxiv_jatsxml_url(url):
    """Fix the double-slash bug in BioRxiv API jatsxml URLs."""
    return re.sub(r'(?<!:)//', '/', url)


def fetch_biorxiv_jats(art):
    """Fetch JATS XML full text from BioRxiv. Returns markdown string or None."""
    jatsxml_url = art.get("jatsxml", "")
    if not jatsxml_url:
        doi = art.get("doi", "")
        date_str = art.get("date", "")
        server = art.get("server", "biorxiv")
        if doi and date_str:
            slug = doi.split("/", 1)[-1] if "/" in doi else doi
            date_path = date_str.replace("-", "/")
            jatsxml_url = f"https://www.{server}.org/content/early/{date_path}/{slug}.source.xml"

    if not jatsxml_url:
        log(f"  No JATS XML URL available")
        return None

    jatsxml_url = fix_biorxiv_jatsxml_url(jatsxml_url)
    log(f"  Fetching JATS XML: {jatsxml_url}")

    data = _curl_get(jatsxml_url, timeout=60)
    if data is None:
        return None

    try:
        root = ET.fromstring(data)
        md = _jats_to_markdown(root)
        if md:
            log(f"  JATS XML parsed: {len(md)} chars")
        return md
    except ET.ParseError as e:
        log(f"  JATS XML parse error: {e}")
        return None


def add_biorxiv_paper(raw_input, vault_pmids, vault_dois, dry_run=False):
    """Fetch and add a BioRxiv/MedRxiv preprint. Returns 'added', 'skipped', or 'failed'."""
    doi, server = parse_biorxiv_input(raw_input)
    if not doi:
        log(f"  Could not parse BioRxiv DOI from: {raw_input}")
        return "failed"

    if doi.lower() in vault_dois:
        log(f"  DOI {doi} already in vault — skipping")
        return "skipped"

    art = fetch_biorxiv_metadata(doi, server)
    if not art:
        log(f"  Failed to fetch metadata for {doi}")
        return "failed"

    log(f"  Found: {art.get('title', '')[:65]}")

    jats_md = fetch_biorxiv_jats(art)

    fm = {}
    fm["pmid"]    = art.get("pmid")
    fm["pmcid"]   = None
    fm["title"]   = art.get("title", "")
    fm["authors"] = art.get("authors", [])
    fm["year"]    = art.get("year")
    fm["journal"] = art.get("journal", "BioRxiv")
    fm["volume"]  = None
    fm["issue"]   = None
    fm["pages"]   = None
    fm["doi"]     = art.get("doi", doi)
    fm["type"]    = "primary"
    fm["lab"]     = None

    if jats_md:
        fm["full_text"]         = True
        fm["enrichment_status"] = "biorxiv"
    else:
        fm["full_text"]         = False
        fm["enrichment_status"] = "abstract-only"

    fm["status"]    = "preprint"
    fm["subtopics"] = [art["category"]] if art.get("category") else []
    fm["key_findings"] = key_findings_from_abstract(art.get("abstract", ""))
    fm["related_papers"] = []

    if jats_md:
        body = "\n" + jats_md + "\n"
    elif art.get("abstract"):
        body = f"\n## Abstract\n\n{art['abstract']}\n"
    else:
        body = "\n"

    content = write_frontmatter(fm, body)

    filename = make_filename(art)
    outpath = VAULT_DIR / filename

    if outpath.exists():
        stem = outpath.stem
        outpath = VAULT_DIR / f"{stem}-preprint.md"
        filename = outpath.name

    status_label = "full-text" if jats_md else "abstract-only"
    log(f"  → {filename} [preprint, {status_label}]")

    if dry_run:
        log(f"  [DRY RUN] Would write {len(content)} chars")
        return "added"

    outpath.write_text(content, encoding="utf-8")
    vault_dois.add(doi.lower())

    return "added"


# ── Frontmatter serialization ──────────────────────────────────────────────────

def write_frontmatter(fm, body):
    """Serialize frontmatter dict + body to complete file string."""
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


# ── File generation ────────────────────────────────────────────────────────────

def make_filename(art):
    """Generate vault filename from article metadata.
    Format: LastName-Year-Short_title_slug.md
    """
    authors = art.get("authors", [])
    first_author = ""
    if authors:
        first_author = str(authors[0]).split()[-1].rstrip(".")
    year = art.get("year", "")
    title = art.get("title", "")

    stop = {"a", "an", "the", "of", "in", "for", "and", "or", "is", "to",
            "by", "on", "at", "with", "from", "that", "this", "are"}
    words = [w for w in re.findall(r"[a-zA-Z0-9]+", title)
             if w.lower() not in stop][:6]
    slug = "_".join(words)[:50]

    if first_author and year:
        name = f"{first_author}-{year}-{slug}"
    elif first_author:
        name = f"{first_author}-{slug}"
    elif year:
        name = f"{year}-{slug}"
    else:
        name = slug or f"paper-{art.get('pmid', 'unknown')}"

    name = re.sub(r'[^\w\-]', '_', name)
    name = re.sub(r'_+', '_', name).strip("_")
    return f"{name}.md"


def key_findings_from_abstract(abstract, n=4):
    """Extract key sentences from abstract for key_findings."""
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


def make_vault_content(art, pmc_text=None, ris_abstract=None):
    """Build complete vault file content (frontmatter + body)."""
    fm = {}

    fm["pmid"]    = art.get("pmid")
    fm["pmcid"]   = art.get("pmcid") or None
    fm["title"]   = art.get("title", "")
    fm["authors"] = art.get("authors", [])
    fm["year"]    = art.get("year")
    fm["journal"] = art.get("journal", "")
    fm["volume"]  = art.get("volume") or None
    fm["issue"]   = art.get("issue") or None
    fm["pages"]   = art.get("pages") or None
    fm["doi"]     = art.get("doi") or None
    fm["type"]    = "primary"
    fm["lab"]     = None

    # PMC sometimes returns only the abstract even when a PMCID exists.
    # Validate that we got real body text (section headers beyond Abstract).
    pmc_has_body = pmc_text and pmc_text.count('\n## ') > 1
    if pmc_has_body:
        fm["full_text"]         = True
        fm["enrichment_status"] = "pmcid"
    elif pmc_text:
        log(f"  PMC returned abstract-only text (no body sections) — marking as abstract-only")
        fm["full_text"]         = False
        fm["enrichment_status"] = "abstract-only"
    else:
        fm["full_text"]         = False
        fm["enrichment_status"] = "abstract-only"

    mesh = art.get("mesh_terms", [])
    fm["subtopics"] = mesh if mesh else []

    abstract = art.get("abstract") or ris_abstract or ""
    fm["key_findings"] = key_findings_from_abstract(abstract)
    fm["related_papers"] = []

    if pmc_text:
        body = "\n" + pmc_text + "\n"
    elif abstract:
        body = f"\n## Abstract\n\n{abstract}\n"
    else:
        body = "\n"

    return write_frontmatter(fm, body)


# ── Per-paper driver ───────────────────────────────────────────────────────────

def add_paper(pmid, vault_pmids, vault_dois, ris_record=None, dry_run=False):
    """Fetch and add a single paper. Returns 'added', 'skipped', or 'failed'."""
    pmid = str(pmid).strip()

    if pmid in vault_pmids:
        log(f"  PMID {pmid} already in vault — skipping")
        return "skipped"

    log(f"  Fetching PubMed: {pmid}")
    art = fetch_pubmed(pmid)
    if not art:
        log(f"  PubMed fetch failed for PMID {pmid}")
        return "failed"

    art_pmid = art.get("pmid", pmid)
    art_doi = (art.get("doi") or "").lower()
    art_title = art.get("title", "")[:65]
    log(f"  Found: {art_title}")

    if art_doi and art_doi in vault_dois:
        log(f"  DOI {art_doi} already in vault — skipping")
        return "skipped"

    pmc_text = None
    pmcid = art.get("pmcid")
    if pmcid:
        pmc_text = fetch_pmc_text(pmcid)
        if pmc_text:
            log(f"  PMC full text fetched: {len(pmc_text)} chars")
        else:
            log(f"  PMC fetch failed — using abstract")
    else:
        log(f"  No PMCID — abstract-only")

    ris_abstract = (ris_record or {}).get("abstract")

    filename = make_filename(art)
    outpath = VAULT_DIR / filename

    if outpath.exists():
        stem = outpath.stem
        outpath = VAULT_DIR / f"{stem}-{art_pmid}.md"
        filename = outpath.name

    content = make_vault_content(art, pmc_text=pmc_text, ris_abstract=ris_abstract)

    status = "pmcid" if pmc_text else "abstract-only"
    log(f"  → {filename} [{status}]")

    if dry_run:
        log(f"  [DRY RUN] Would write {len(content)} chars")
        return "added"

    outpath.write_text(content, encoding="utf-8")
    vault_pmids.add(art_pmid)
    if art_doi:
        vault_dois.add(art_doi)

    return "added"


# ── CLI ────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pmids", nargs="*", help="PMIDs to add directly")
    parser.add_argument("--ris", metavar="FILE", help="RIS file to import")
    parser.add_argument("--file", metavar="FILE", help="Text file with one PMID per line")
    parser.add_argument("--biorxiv", nargs="+", metavar="URL_OR_DOI",
                        help="BioRxiv/MedRxiv URLs or DOIs to add as preprints")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing files")
    parser.add_argument("--batch-size", type=int, default=0,
                        help="Stop after N papers added (0=no limit)")
    args = parser.parse_args()

    if not args.pmids and not args.ris and not args.file and not args.biorxiv:
        parser.print_help()
        sys.exit(1)

    log(f"\n{'='*60}")
    log(f"add-paper.py started {'(DRY RUN)' if args.dry_run else ''}")

    vault_pmids, vault_dois = load_vault_index()
    log(f"Vault index: {len(vault_pmids)} PMIDs, {len(vault_dois)} DOIs")

    work = []

    if args.ris:
        ris_path = Path(args.ris)
        if not ris_path.exists():
            log(f"RIS file not found: {ris_path}")
            sys.exit(1)
        records = parse_ris(ris_path)
        log(f"Parsed {len(records)} records from {ris_path.name}")
        for rec in records:
            pmid = rec.get("pmid")
            if pmid:
                work.append((pmid, rec))
            else:
                doi = rec.get("doi", "")
                title = rec.get("title", "")[:50]
                log(f"  No PMID in RIS record: {title or doi or '(no title)'} — skipping")

    if args.file:
        fpath = Path(args.file)
        if not fpath.exists():
            log(f"PMID file not found: {fpath}")
            sys.exit(1)
        file_pmids = [line.strip() for line in fpath.read_text().splitlines()
                      if line.strip() and line.strip().isdigit()]
        log(f"Read {len(file_pmids)} PMIDs from {fpath.name}")
        for pmid in file_pmids:
            work.append((pmid, None))

    for pmid in args.pmids:
        work.append((pmid.strip(), None))

    if args.biorxiv:
        log(f"Processing {len(args.biorxiv)} BioRxiv/MedRxiv preprints...")
        biorxiv_counts = {"added": 0, "skipped": 0, "failed": 0}
        for i, raw in enumerate(args.biorxiv):
            log(f"\n-- [{i+1}/{len(args.biorxiv)}] {raw}")
            result = add_biorxiv_paper(raw, vault_pmids, vault_dois,
                                       dry_run=args.dry_run)
            biorxiv_counts[result] += 1
        log(f"\nBioRxiv: Added: {biorxiv_counts['added']} | "
            f"Skipped: {biorxiv_counts['skipped']} | "
            f"Failed: {biorxiv_counts['failed']}")
        if not work:
            sys.exit(0)

    if not work:
        log("No PMIDs to process.")
        sys.exit(0)

    log(f"Processing {len(work)} papers...\n")

    counts = {"added": 0, "skipped": 0, "failed": 0}
    for i, (pmid, ris_rec) in enumerate(work):
        log(f"\n-- [{i+1}/{len(work)}] PMID {pmid}")
        result = add_paper(pmid, vault_pmids, vault_dois,
                           ris_record=ris_rec, dry_run=args.dry_run)
        counts[result] += 1

        if args.batch_size and counts["added"] >= args.batch_size:
            log(f"\nBatch limit reached ({args.batch_size} papers added)")
            remaining = len(work) - i - 1
            if remaining > 0:
                log(f"Remaining: {remaining} papers not processed")
            break

    log(f"\n{'='*60}")
    log(f"Added: {counts['added']} | Skipped: {counts['skipped']} | "
        f"Failed: {counts['failed']}")


if __name__ == "__main__":
    main()
