# Changelog

## v0.2.0 — 2026-05-05

Nightly-cron hardening pass. Four production failures backstopped at the source, with defense-in-depth checks in the nightly chain and the librarian sweep.

- **store.ts.patched**: refuses to silently drop a populated `vectors_vec` on dim-mismatch (override with `QMD_ALLOW_VEC_RECREATE=1`). UNIQUE-handler regex broadened to match all sqlite-vec versions.
- **sync-vault.sh**: new Step 1d′ (second dedup pass after LLM title correction) and Step 2a (row-count parity + per-hash seq-gap detection).
- **cluster-vault-graph.py**: `build_knn_graph()` early-return for n<2.
- **enrich-paper.py**: `enrich_file()` no longer stamps `enrichment_status: failed` on `status: in-press` papers.
- **relate-papers.sh**: refuse-to-overwrite guard preserves an existing sidecar when the new computation is implausibly small.
- **vault-librarian.md**: section 6b — percentage-based parity thresholds and per-hash seq-gap detection protocol.
- **check-duplicates.py**: removed dead `--new-only` flag.
- **README.md**: restructured opening, dropped blockquote callouts, added upstream-OSS section, author bio.

## v0.1.0 — initial public release

Reference implementation. Vault pipeline, research digest, Claude Code skills, vault-librarian agent, scientific-identity template, example crontab, setup and customization docs.
