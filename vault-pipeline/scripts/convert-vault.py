#!/usr/bin/env python3
"""
convert-vault.py — Convert PDFs and DOCX files into vault markdown.

Reads from $SOURCE_DIR (read-only as far as this script is concerned), converts
to flat markdown in $VAULT_DIR, and maintains a manifest at $NAV_DIR/_manifest.json.

PDF conversion:
  Primary  — Docling (CPU; runs with --no-ocr by default)
  Fallback — pdftotext (poppler-utils) for PDFs Docling can't handle
DOCX conversion:
  Pandoc

Idempotent on re-runs: the manifest tracks already-converted sources, and the
DOI-extraction shortcut skips PDFs whose DOI matches an already-imported paper.

Usage:
    python convert-vault.py
    python convert-vault.py --dry-run

Required env: VAULT_DIR, SOURCE_DIR.
Optional env: NAV_DIR (default: $VAULT_DIR/../nav), LOG_DIR (default: /tmp),
              DOCLING_BIN (default: docling on PATH).
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# --- CONFIGURATION ---


def _env_path(name: str, required: bool = True, default: Path | None = None) -> Path | None:
    v = os.environ.get(name)
    if v:
        return Path(v).expanduser()
    if default is not None:
        return default
    if required:
        sys.exit(f"ERROR: {name} not set in environment")
    return None


SOURCE_DIR = _env_path("SOURCE_DIR")
assert SOURCE_DIR is not None
VAULT_DIR = _env_path("VAULT_DIR")
assert VAULT_DIR is not None
NAV_DIR = _env_path("NAV_DIR", default=VAULT_DIR.parent / "nav")
LOG_DIR = _env_path("LOG_DIR", default=Path("/tmp"))
DOCLING_BIN = os.environ.get("DOCLING_BIN", "docling")

MANIFEST_FILE = NAV_DIR / "_manifest.json"
LOG_FILE = LOG_DIR / "convert-vault.log"

PDF_EXTENSIONS = {".pdf"}
DOCX_EXTENSIONS = {".docx", ".doc"}

# Minimum word count to consider a conversion successful (catches blank/garbage output)
MIN_WORD_COUNT = 200


def log(msg):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def load_manifest():
    if MANIFEST_FILE.exists():
        with open(MANIFEST_FILE) as f:
            return json.load(f)
    return {}


def save_manifest(manifest):
    NAV_DIR.mkdir(parents=True, exist_ok=True)
    with open(MANIFEST_FILE, "w") as f:
        json.dump(manifest, f, indent=2, default=str)


def sanitize_filename(name):
    """Create a clean filename from the original, preserving readability."""
    stem = Path(name).stem
    clean = re.sub(r'[^\w\s\-\.]', '', stem)
    clean = re.sub(r'[\s_]+', '_', clean).strip('_')
    return clean


def convert_pdf_with_docling(source_path, output_path):
    """Convert PDF to Markdown using Docling CLI."""
    try:
        temp_dir = output_path.parent / "_docling_tmp"
        temp_dir.mkdir(exist_ok=True)

        cmd = [
            DOCLING_BIN,
            "--output", str(temp_dir),
            "--to", "md",
            "--image-export-mode", "placeholder",
            "--no-ocr",
            str(source_path),
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)

        if result.returncode != 0:
            log(f"  Docling error: {result.stderr[:500]}")
            return False

        candidates = list(temp_dir.rglob("*.md"))
        if candidates:
            import shutil
            shutil.move(str(candidates[0]), str(output_path))
            shutil.rmtree(temp_dir, ignore_errors=True)
            return True
        else:
            log(f"  No markdown output found from Docling")
            import shutil
            shutil.rmtree(temp_dir, ignore_errors=True)
            return False

    except subprocess.TimeoutExpired:
        log(f"  Timeout (>10 min)")
        return False
    except Exception as e:
        log(f"  Exception: {e}")
        return False


def convert_pdf_with_pdftotext(source_path, output_path):
    """Fallback PDF converter using pdftotext (poppler-utils)."""
    try:
        result = subprocess.run(
            ["pdftotext", str(source_path), "-"],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0 or not result.stdout.strip():
            log(f"  pdftotext error or empty output")
            return False
        output_path.write_text(result.stdout, encoding="utf-8")
        return True
    except FileNotFoundError:
        log(f"  pdftotext not found (install poppler-utils)")
        return False
    except subprocess.TimeoutExpired:
        log(f"  pdftotext timeout")
        return False
    except Exception as e:
        log(f"  pdftotext exception: {e}")
        return False


def convert_docx_with_pandoc(source_path, output_path):
    """Convert DOCX to Markdown using Pandoc."""
    try:
        cmd = ["pandoc", str(source_path), "-f", "docx", "-t", "markdown",
               "--wrap=none", "-o", str(output_path)]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            log(f"  Pandoc error: {result.stderr[:500]}")
            return False
        return output_path.exists()
    except subprocess.TimeoutExpired:
        log(f"  Pandoc timeout (>2 min)")
        return False
    except Exception as e:
        log(f"  Exception: {e}")
        return False


def extract_metadata(md_path):
    """Extract conservative metadata from converted markdown content.

    Strategy: only extract what we can identify reliably. Title and authors
    are left empty — PubMed enrichment (enrich-paper.py) is the authoritative
    source. Docling is good at converting content but bad at identifying
    which line is the title.
    """
    try:
        content = md_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return {}

    metadata = {"word_count": len(content.split())}

    doi_match = re.search(r'(10\.\d{4,}/[^\s]+)', content[:5000])
    if doi_match:
        metadata["doi"] = doi_match.group(1).rstrip(".,;)")

    return metadata


def generate_stub_frontmatter(source_stem, metadata):
    """Generate a minimal YAML frontmatter stub for a newly converted paper.

    Only populates fields we're confident about: year from filename, DOI from
    regex. Title and authors are left empty — enrich-paper.py fills them
    from PubMed or enrich-llm.py fills them via LLM.
    """
    m = re.search(r'(19|20)\d{2}', source_stem)
    year = m.group() if m else ""

    stem_lower = source_stem.lower()
    doc_type = "review" if "review" in stem_lower else "primary"

    doi = metadata.get("doi", "")

    stub = f'''\
---
pmid: ""
title: ""
authors: []
year: {year}
journal: ""
doi: "{doi}"
type: {doc_type}
full_text: true
subtopics: []
key_findings: []
related_papers: []
---
'''
    return stub


def build_vault_doi_index():
    """Build an index of DOIs already in the vault.

    Returns: {doi_lower: {"path": Path, "has_full_text": bool}}

    `has_full_text` is True when the existing entry has real body text
    (full_text: true AND enrichment_status != abstract-only). Abstract-only
    stubs are NOT treated as full text — a matching PDF should upgrade them.
    """
    index = {}
    for md in VAULT_DIR.glob("*.md"):
        if md.name.startswith("_"):
            continue
        try:
            with open(md, "r", encoding="utf-8", errors="replace") as f:
                head = f.read(4096)
            fm_match = re.match(r'^---\n(.*?)\n---', head, re.DOTALL)
            if not fm_match:
                continue
            fm = fm_match.group(1)
            doi_m = re.search(r'^doi:\s*"?([^"\s]+)"?', fm, re.MULTILINE)
            if not doi_m:
                continue
            doi = doi_m.group(1).lower().rstrip(".,;)")

            ft_m = re.search(r'^full_text:\s*(\S+)', fm, re.MULTILINE)
            full_text = ft_m and ft_m.group(1).strip().lower() == "true"
            es_m = re.search(r'^enrichment_status:\s*(\S+)', fm, re.MULTILINE)
            status = es_m.group(1).strip().strip('"') if es_m else ""
            has_full_text = bool(full_text) and status != "abstract-only"

            index[doi] = {"path": md, "has_full_text": has_full_text}
        except Exception:
            continue
    return index


def upgrade_stub_with_pdf(stub_path, pdf_path):
    """Convert a PDF and merge its body into an existing abstract-only stub.

    Preserves the stub's PubMed-sourced frontmatter, replaces the body with
    Docling output, and flips full_text/enrichment_status. Returns
    (success, method, quality).
    """
    tmp_md = stub_path.parent / f"_pdf_upgrade_tmp_{os.getpid()}.md"
    method = "docling"
    success = convert_pdf_with_docling(pdf_path, tmp_md)
    if not success:
        log(f"  Docling failed, trying pdftotext fallback...")
        success = convert_pdf_with_pdftotext(pdf_path, tmp_md)
        method = "pdftotext" if success else "unknown"

    if not success or not tmp_md.exists():
        if tmp_md.exists():
            tmp_md.unlink()
        return False, method, "failed"

    try:
        new_body = tmp_md.read_text(encoding="utf-8", errors="replace")
        new_body = re.sub(r'^---\n.*?\n---\n+', '', new_body, count=1, flags=re.DOTALL)

        word_count = len(new_body.split())
        quality = "ok" if word_count >= MIN_WORD_COUNT else "low"
        if method == "docling" and quality == "ok":
            quality = "high"

        existing = stub_path.read_text(encoding="utf-8", errors="replace")
        fm_match = re.match(r'^(---\n.*?\n---\n)', existing, re.DOTALL)
        if not fm_match:
            log(f"  WARNING: stub {stub_path.name} has no frontmatter — aborting merge")
            return False, method, quality
        fm_block = fm_match.group(1)

        fm_block = re.sub(
            r'^full_text:\s*\S+',
            'full_text: true',
            fm_block, count=1, flags=re.MULTILINE,
        )
        if re.search(r'^enrichment_status:', fm_block, re.MULTILINE):
            fm_block = re.sub(
                r'^enrichment_status:\s*\S+',
                'enrichment_status: pubmed',
                fm_block, count=1, flags=re.MULTILINE,
            )

        stub_path.write_text(fm_block + "\n" + new_body, encoding="utf-8")
        return True, method, quality
    finally:
        if tmp_md.exists():
            tmp_md.unlink()


def extract_doi_from_pdf_fast(source_path):
    """Try to extract a DOI from a PDF without full conversion."""
    try:
        result = subprocess.run(
            ["pdftotext", "-l", "2", str(source_path), "-"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0 and result.stdout:
            m = re.search(r'(10\.\d{4,}/[^\s]+)', result.stdout[:3000])
            if m:
                return m.group(1).rstrip(".,;)")
    except Exception:
        pass
    return None


def main():
    dry_run = "--dry-run" in sys.argv

    log("=== convert-vault.py started ===")

    if not SOURCE_DIR.exists():
        log(f"ERROR: Source directory not found: {SOURCE_DIR}")
        sys.exit(1)

    VAULT_DIR.mkdir(parents=True, exist_ok=True)

    manifest = load_manifest()
    vault_dois = build_vault_doi_index()
    log(f"Vault DOI index: {len(vault_dois)} DOIs "
        f"({sum(1 for v in vault_dois.values() if not v['has_full_text'])} abstract-only stubs)")

    source_files = []
    for ext in PDF_EXTENSIONS | DOCX_EXTENSIONS:
        source_files.extend(SOURCE_DIR.rglob(f"*{ext}"))

    log(f"Found {len(source_files)} source files in {SOURCE_DIR}")

    converted = skipped = failed = 0

    for source_path in sorted(source_files):
        clean_name = sanitize_filename(source_path.name)
        output_md = VAULT_DIR / f"{clean_name}.md"

        source_key = str(source_path.relative_to(SOURCE_DIR))
        if source_key in manifest:
            if manifest[source_key].get("skip", False):
                dup_of = manifest[source_key].get("duplicate_of", "")
                revisit = False
                if dup_of.startswith("DOI:"):
                    skip_doi = dup_of[4:].lower()
                    entry = vault_dois.get(skip_doi)
                    if entry and not entry["has_full_text"]:
                        revisit = True
                if revisit:
                    log(f"  Revisiting (vault entry for {dup_of} is abstract-only): {source_path.name}")
                    del manifest[source_key]
                else:
                    log(f"  Skipping (duplicate of {dup_of or '?'}): {source_path.name}")
                    skipped += 1
                    continue

        if output_md.exists():
            try:
                existing = output_md.read_text(encoding="utf-8", errors="replace")
                if "full_text: false" not in existing and "full_text: submitted" not in existing:
                    skipped += 1
                    continue
                else:
                    log(f"  Partial stub found — overwriting with full text: {output_md.name}")
            except Exception:
                skipped += 1
                continue

        if source_key in manifest:
            if Path(manifest[source_key].get("output_path", "")).exists():
                skipped += 1
                continue

        if source_path.suffix.lower() in PDF_EXTENSIONS:
            pdf_doi = extract_doi_from_pdf_fast(source_path)
            if pdf_doi and pdf_doi.lower() in vault_dois:
                vault_entry = vault_dois[pdf_doi.lower()]
                stub_path = vault_entry["path"]

                if vault_entry["has_full_text"]:
                    log(f"  Skipping (DOI {pdf_doi} already has full text): {source_path.name}")
                    manifest[source_key] = {
                        "source_file": source_path.name,
                        "source_path": source_key,
                        "skip": True,
                        "duplicate_of": f"DOI:{pdf_doi}",
                        "converted_date": datetime.now().isoformat(),
                    }
                    skipped += 1
                    continue

                log(f"Upgrading abstract-only stub with PDF: {source_path.name} → {stub_path.name}")
                if dry_run:
                    log(f"  [DRY RUN] Would merge Docling output into {stub_path.name}")
                    converted += 1
                    continue

                ok, method, quality = upgrade_stub_with_pdf(stub_path, source_path)
                if ok:
                    vault_entry["has_full_text"] = True
                    manifest[source_key] = {
                        "source_file": source_path.name,
                        "source_path": source_key,
                        "output_file": stub_path.name,
                        "output_path": str(stub_path),
                        "converted_date": datetime.now().isoformat(),
                        "file_type": source_path.suffix.lower(),
                        "file_size_bytes": source_path.stat().st_size,
                        "conversion_method": method,
                        "conversion_quality": quality,
                        "upgraded_stub": True,
                        "doi": pdf_doi,
                    }
                    log(f"  OK: upgraded {stub_path.name} (method={method}, quality={quality})")
                    converted += 1
                else:
                    log(f"  FAILED to upgrade stub: {source_path.name}")
                    failed += 1
                continue

        log(f"Converting: {source_path.name}")

        if dry_run:
            log(f"  [DRY RUN] Would convert to: {output_md.name}")
            converted += 1
            continue

        ext = source_path.suffix.lower()
        success = False
        conversion_method = "unknown"

        if ext in PDF_EXTENSIONS:
            success = convert_pdf_with_docling(source_path, output_md)
            if success:
                conversion_method = "docling"
            else:
                log(f"  Docling failed, trying pdftotext fallback...")
                success = convert_pdf_with_pdftotext(source_path, output_md)
                if success:
                    conversion_method = "pdftotext"
                    log(f"  pdftotext fallback succeeded")
        elif ext in DOCX_EXTENSIONS:
            success = convert_docx_with_pandoc(source_path, output_md)
            if success:
                conversion_method = "pandoc"
        else:
            log(f"  Unsupported format: {ext}")
            failed += 1
            continue

        if success and output_md.exists():
            word_count_check = len(output_md.read_text(encoding="utf-8", errors="replace").split())
            conversion_quality = "ok" if word_count_check >= MIN_WORD_COUNT else "low"
            if conversion_quality == "low":
                log(f"  WARNING: Low word count ({word_count_check} words) — may need manual review")
            metadata = extract_metadata(output_md)

            try:
                content = output_md.read_text(encoding="utf-8", errors="replace")
                if not content.startswith("---"):
                    stub = generate_stub_frontmatter(source_path.stem, metadata)
                    output_md.write_text(stub + "\n" + content, encoding="utf-8")
                    log(f"  Added stub frontmatter")
            except Exception as e:
                log(f"  Warning: could not add frontmatter: {e}")

            manifest[source_key] = {
                "source_file": source_path.name,
                "source_path": source_key,
                "output_file": output_md.name,
                "output_path": str(output_md),
                "converted_date": datetime.now().isoformat(),
                "file_type": ext,
                "file_size_bytes": source_path.stat().st_size,
                "conversion_method": conversion_method,
                "conversion_quality": conversion_quality,
                **metadata,
            }

            log(f"  OK: {output_md.name} ({metadata.get('word_count', '?')} words)")
            converted += 1
        else:
            failed += 1
            log(f"  FAILED: {source_path.name}")

    if not dry_run:
        save_manifest(manifest)

    log(f"=== Done: {converted} converted, {skipped} skipped, {failed} failed ===")
    log(f"Total in vault (manifest): {len(manifest)} entries")


if __name__ == "__main__":
    main()
