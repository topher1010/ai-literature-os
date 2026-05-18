# Changelog

## v0.3.0 — 2026-05-18

Two new Claude Code skills shipped: `/critique` (adversarial review of a draft) and `/consensus-check` (optional, Consensus.app integration for claim-defensibility checking). The pair is independent; either can be installed alone.

- **`claude-code-skills/critique/`** — read-only adversarial reviewer for a science document. Takes a doc path, mechanically verifies every PMID against PubMed, and triages claims against eight failure modes: `wrong_pmid`, `single_source_contrarian`, `single_paper_synthesis`, `cross_domain_leap`, `exceeds_cited_evidence`, `coverage_gap`, `abstract_vs_fulltext`, `confidence_without_convergence`. Returns a structured concerns list with severity, confidence, and dismissable-conditions. ~10–15 Phase-2 tool calls beyond mandatory PMID fetches.
- **`claude-code-skills/consensus-check/`** — optional, vendor-dependent. Queries Consensus.app's MCP server (200M+ peer-reviewed papers) for one claim per invocation. Targeted at claim-defensibility checking during grant prose drafting. Explicit-invocation-only by design (configurable in frontmatter if you prefer different defaults). Quota tracked in `${CLAUDE_STATE_DIR:-~/.claude/state}/consensus-quota.json` with monthly auto-reset; defaults match the free MCP tier (30/month, warn at 24).
- **`docs/setup.md`** — new Step 8b walks through Consensus.app integration: account signup, MCP server registration, OAuth (with notes on the SSH-headless gotcha and the VS Code Remote-SSH workaround), quota state file, allowlist entry.
- **`claude-code-skills/README.md`** — updated to five skills with a Public Maturity table that names external dependencies per skill, plus documentation of the optional `/critique` → `/consensus-check` chaining pattern (three of eight failure modes benefit; the other five don't).
- **README.md** — updated `claude-code-skills/` row in the components table to reflect the new skills and the vendor dependency on `/consensus-check`.

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
