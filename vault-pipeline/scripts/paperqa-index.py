#!/usr/bin/env python3
"""
paperqa-index.py - Build and maintain a PaperQA2 index from the vault.

Builds the index by adding each paper manually with citation info from YAML
frontmatter - this skips PaperQA2's LLM citation-extraction step entirely.
Only the embedding API (OpenRouter/Gemini) is called during indexing.

Incremental mode (default): loads the existing index and only embeds papers
not already present, or whose body text has changed since the last index run.
Tracks state in a sidecar JSON file (filename -> sha256 of body text) so we
don't have to introspect PaperQA2 internals.

Body-only hashing avoids re-indexing on pure frontmatter edits (integration
tags, etc.); a real body change from upgrade-stubs.py / upgrade-preprints.py
shifts the hash and forces re-index.

Pass --rebuild to force a full re-index from scratch. Run periodically
(monthly, or after large imports) to clean up duplicate chunks left by
re-indexing changed papers.

Required env: VAULT_DIR, OPENROUTER_API_KEY, ANTHROPIC_API_KEY.
Optional env: PQA_INDEX_DIR (default: $NAV_DIR/paperqa-index).
"""

import asyncio
import hashlib
import json
import os
import sys
import pickle  # noqa: S403 - PaperQA2's index format requires this
from pathlib import Path


def _env_path(name: str, required: bool = True, default: Path | None = None) -> Path | None:
    v = os.environ.get(name)
    if v:
        return Path(v).expanduser()
    if default is not None:
        return default
    if required:
        sys.exit(f"ERROR: {name} not set in environment")
    return None


VAULT_DIR = _env_path("VAULT_DIR")
assert VAULT_DIR is not None
NAV_DIR = _env_path("NAV_DIR", default=VAULT_DIR.parent / "nav")
INDEX_DIR = _env_path("PQA_INDEX_DIR", default=NAV_DIR / "paperqa-index")

if not os.environ.get("OPENROUTER_API_KEY"):
    sys.exit("ERROR: OPENROUTER_API_KEY not set in environment")

INDEX_FILE = INDEX_DIR / "docs.pkl"
INDEXED_FILES = INDEX_DIR / "indexed-files.json"

from paperqa import Docs, Settings  # noqa: E402
from paperqa.settings import ParsingSettings, MultimodalOptions  # noqa: E402


SETTINGS = Settings(
    llm=os.environ.get("PQA_LLM", "claude-sonnet-4-6"),
    summary_llm=os.environ.get("PQA_SUMMARY_LLM", "claude-haiku-4-5-20251001"),
    embedding=os.environ.get(
        "PQA_EMBEDDING_MODEL", "openrouter/google/gemini-embedding-2-preview"
    ),
    verbosity=0,
    parsing=ParsingSettings(
        use_doc_details=False,
        multimodal=MultimodalOptions.OFF,
    ),
)


def parse_yaml_frontmatter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    yaml_block = text[3:end]
    result = {}
    for line in yaml_block.splitlines():
        if ":" in line and not line.strip().startswith("-"):
            key, _, val = line.partition(":")
            result[key.strip()] = val.strip().strip('"').strip("'")
    return result


def body_hash(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            text = text[end + 4:]
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def load_index_sidecar() -> dict[str, str]:
    if not INDEXED_FILES.exists():
        return {}
    raw = json.loads(INDEXED_FILES.read_text())
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, list):
        print(f"  Migrating legacy flat-list sidecar ({len(raw)} entries) to hash map...")
        migrated: dict[str, str] = {}
        for fname in raw:
            p = VAULT_DIR / fname
            if p.exists():
                migrated[fname] = body_hash(p)
        return migrated
    return {}


def make_citation(meta: dict, filename: str) -> str:
    authors = meta.get("authors", meta.get("first_author", ""))
    year = meta.get("year", "")
    title = meta.get("title", filename)
    journal = meta.get("journal", "")
    doi = meta.get("doi", "")

    title = title.strip('"').strip("'")

    parts = []
    if authors:
        parts.append(authors)
    if title:
        parts.append(f'"{title}"')
    if journal:
        parts.append(journal)
    if year:
        parts.append(str(year))
    if doi:
        parts.append(f"doi:{doi}")

    return ", ".join(parts) if parts else f"Unknown, {filename}"


async def build_index():
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    rebuild = "--rebuild" in sys.argv

    papers = sorted(
        [p for p in VAULT_DIR.glob("*.md") if not p.name.startswith("_")]
    )
    print(f"Vault: {len(papers)} papers")
    print(f"Index: {INDEX_FILE}")

    docs = Docs()
    indexed_hashes: dict[str, str] = {}

    if not rebuild and INDEX_FILE.exists() and INDEXED_FILES.exists():
        print("Loading existing index...")
        try:
            with open(INDEX_FILE, "rb") as f:
                docs = pickle.load(f)  # noqa: S301
            indexed_hashes = load_index_sidecar()
            print(f"  Loaded: {len(indexed_hashes)} papers already indexed")
        except Exception as e:
            print(f"  WARNING: could not load existing index ({e}), rebuilding from scratch")
            docs = Docs()
            indexed_hashes = {}
    elif rebuild:
        print("--rebuild: starting from scratch")
    else:
        print("No existing index found, building from scratch")

    to_index: list[tuple[Path, str, str]] = []
    for p in papers:
        current = body_hash(p)
        prior = indexed_hashes.get(p.name)
        if prior is None:
            to_index.append((p, current, "new"))
        elif prior != current:
            to_index.append((p, current, "changed"))

    if not to_index:
        print("All papers already indexed at current body hash, nothing to do.")
        return

    new_count = sum(1 for _, _, r in to_index if r == "new")
    changed_count = sum(1 for _, _, r in to_index if r == "changed")
    print(f"To index: {len(to_index)} ({new_count} new, {changed_count} body-changed)\n")

    errors = []

    for i, (paper_path, current_hash, reason) in enumerate(to_index, 1):
        meta = parse_yaml_frontmatter(paper_path)
        citation = make_citation(meta, paper_path.stem)
        tag = "NEW " if reason == "new" else "CHGD"
        print(f"[{i:3d}/{len(to_index)}] {tag} {paper_path.name[:60]}")
        try:
            await docs.aadd(
                paper_path,
                citation=citation,
                settings=SETTINGS,
            )
            indexed_hashes[paper_path.name] = current_hash
        except Exception as e:
            print(f"          ERROR: {e}")
            errors.append((paper_path.name, str(e)))

    print(f"\nIndexed {len(to_index) - len(errors)} papers ({len(errors)} errors)")
    print(f"Total tracked: {len(indexed_hashes)} papers, {len(docs.texts)} text chunks")
    if errors:
        print(f"Errors ({len(errors)}):")
        for name, err in errors:
            print(f"  {name}: {err}")

    print(f"\nSaving index to {INDEX_FILE}...")
    with open(INDEX_FILE, "wb") as f:
        pickle.dump(docs, f)
    INDEXED_FILES.write_text(
        json.dumps(dict(sorted(indexed_hashes.items())), indent=2)
    )
    print(f"Index size: {INDEX_FILE.stat().st_size / 1024 / 1024:.1f} MB")
    print("Done.")


if __name__ == "__main__":
    asyncio.run(build_index())
