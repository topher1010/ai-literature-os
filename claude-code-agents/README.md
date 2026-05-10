# `claude-code-agents/`

```
claude-code-agents/
└── vault-librarian.md   # Cron-scheduled health-check agent (Tue/Fri 4am)
```

> **Agent-agnostic note.** The file is Claude Code's agent format. The *operation* — a scheduled audit of paper counts, hash churn, integration backlog, cluster quality, and digest run reports — is general and could be run by any agent runtime against the same vault and nav layer.

## What the librarian does

Audits pipeline health and writes a report to a configurable location. Sections include:

1. Vault inventory — paper counts by status, enrichment tier, integration flag
2. Hash-churn watch — papers rewritten in last 24h vs day's intake count
3. Enrichment failures — papers stuck in `enrichment_status: failed`
4. PMC false-positive watch — papers claiming `full_text: true` but body < 50 lines
5. Topic-cluster quality — Leiden cluster sizes, label coherence observations
6. Sidecar coverage — papers in `_related-papers.json` neighbor counts
7. Index freshness — last successful `qmd embed`, `cluster-vault-graph.py`, etc.
8. Research-digest run-report audit — most recent run's `result:` field, scoring/summary failure counts

## How sanitization was done

The shipped agent uses `$VAULT_DIR` and `$NAV_DIR` env vars and contains no research-specific topic-cluster names — examples are presented in the abstract (HETEROGENEOUS / REDUNDANT / MISLABELED categories), not as named clusters. The agent is a good template for any cron-scheduled health check against any vault.

## Installation

```bash
cp claude-code-agents/vault-librarian.md ~/.claude/agents/
```

Then schedule it via cron — see [`cron/example-crontab`](../cron/example-crontab).
