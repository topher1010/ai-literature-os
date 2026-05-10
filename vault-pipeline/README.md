# `vault-pipeline/`

Scripts that intake, enrich, and index papers in the vault, plus the QMD patches.

```
vault-pipeline/
├── scripts/                  # ~17 Python and shell scripts
│   ├── sync-vault.sh         # Top-level nightly orchestrator
│   ├── add-paper.py          # PMID-first intake (RIS, PMID list, bioRxiv DOI)
│   ├── convert-vault.py      # PDF/DOCX → markdown via Docling
│   ├── check-duplicates.py   # PMID/DOI/title dedup
│   ├── enrich-paper.py       # Tier 2: PubMed metadata
│   ├── enrich-llm.py         # Tier 3: Claude Sonnet fallback
│   ├── upgrade-stubs.py      # Re-check abstract-only papers for new PMC text
│   ├── upgrade-preprints.py  # Check preprints for published versions
│   ├── integrate-paper.sh    # LLM tagging (read-only, structured output)
│   ├── generate-summary.py   # Deep-dive paper summaries
│   ├── generate-index.py     # Rebuild _index.md
│   ├── cluster-vault-graph.py # Leiden community detection + LLM labels
│   ├── relate-papers.sh      # Cosine-similarity neighbor sidecar
│   ├── paperqa-index.py      # PaperQA2 index update (body-sha256 tracked)
│   ├── pqa-query.sh          # PaperQA2 query wrapper
│   ├── qmd-openrouter.sh     # QMD wrapper that routes embeddings via OpenRouter
│   └── parse-endnote.py      # Extract PMIDs from Endnote XML (one-off utility)
├── qmd-patches/              # Patches against pinned QMD commit
│   ├── README.md             # Which commit + how to apply
│   ├── llm.ts.patched        # OpenRouter transport + loud-fail
│   └── store.ts.patched      # vec0 UNIQUE constraint fix
└── requirements.txt          # paperqa, docling, openai, anthropic, litellm
```

## How sanitization was done

All shipped scripts read paths from env vars (`$VAULT_DIR`, `$NAV_DIR`, `$SOURCE_DIR`, `$LOG_DIR`, `$PQA_INDEX_DIR`, `$CLAUDE_BIN`) and have no hardcoded `~/Projects/…` paths, lab-specific filters, or original Supabase project IDs. The pre-commit hook in `.githooks/pre-commit` enforces this on every commit.

If you fork the repo and add scripts of your own, run `git config core.hooksPath .githooks` once so the hook checks your additions too.
