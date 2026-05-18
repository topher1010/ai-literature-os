# `claude-code-skills/`

Five [Claude Code skills](https://docs.claude.com/en/docs/claude-code/skills) that I happen to use. Each runs in forked context to keep search results and verification chatter out of the main session.

> **Agent-agnostic note.** These specific files are Claude Code's skill format — slash commands, frontmatter, allowed-tools. The *operations* they wrap (vault search, deep synthesis, paper intake, adversarial review, claim verification) are general; another agent runtime would need its own equivalents but would do the same work against the same vault and nav layer.

```
claude-code-skills/
├── science-search/      # Fast vault + PubMed search (2-10 sec)
├── deep-synthesis/      # PaperQA2 vault-wide synthesis (30-60 sec)
├── add-papers/          # PMID/DOI/bioRxiv intake; updates QMD + PaperQA2 immediately
├── critique/            # Adversarial review of a draft: PMID verification + 8 failure modes
└── consensus-check/     # Optional. Claim-defensibility check via Consensus.app MCP (vendor dep)
```

## Routing

- `/science-search` — to **find** papers
- `/deep-synthesis` — for **integrated answers** across many papers
- `/add-papers` — to **import** new ones (auto-indexed)
- `/critique` — to **stress-test a draft** for citation/synthesis problems before it ships
- `/consensus-check` — to **verify a specific claim** against the broader literature aggregate (Consensus.app, paid third-party)

The first three cross-reference each other and suggest the alternative when appropriate. `/critique` is read-only and returns a concerns list. `/consensus-check` is explicit-invocation-only.

## Public maturity

| Skill | Setup cost | External dependency | Maturity |
|---|---|---|---|
| `/science-search` | none beyond the vault pipeline | PubMed (free) | Drop-in if you use Claude Code. |
| `/deep-synthesis` | PaperQA2 index + OpenRouter | OpenRouter (paid) | Drop-in. Costs ~3¢/query against your own OpenRouter credit. |
| `/add-papers` | `add-paper.py` on PATH | PubMed + bioRxiv (free) | Drop-in. |
| `/critique` | none beyond the vault pipeline | PubMed (free) | Drop-in. |
| `/consensus-check` | Consensus.app account + MCP install + OAuth | Consensus.app (free tier = 30/month MCP queries; paid tiers exist) | Drop-in if you use Claude Code AND have a Consensus.app account. See [`docs/setup.md`](../docs/setup.md) → "Consensus.app integration." |

## The `/critique` → `/consensus-check` pairing (optional)

A useful pattern when running `/critique` on a draft: three of `/critique`'s eight failure-mode tags are good candidates for a targeted `/consensus-check` follow-up by the user:

- `single_paper_synthesis` — does the broader literature corroborate the one-paper anchor?
- `single_source_contrarian` — does the field aggregate confirm or contradict the contrarian framing?
- `confidence_without_convergence` — is convergent evidence actually out there?

The other five `/critique` tags (`wrong_pmid`, `cross_domain_leap`, `exceeds_cited_evidence`, `coverage_gap`, `abstract_vs_fulltext`) are resolved internally by `/critique`'s own PubMed and vault checks — chaining to Consensus wastes quota.

The pairing is **opt-in**: `/critique` will not auto-recommend running `/consensus-check`, and `/consensus-check` is explicit-invocation-only in the shipped configuration. The user decides whether external corroboration is warranted, claim by claim. Cap at ~3 chained queries per `/critique` session.

## No writing skill is shipped here

This repo helps you find, organize, synthesize, and stress-test evidence; the writing is yours. If you want a writing-assist skill in your own private setup, build one — but consider [NIH AI policy](https://grants.nih.gov/) and your target journal's policy first.

## How sanitization was done

The shipped skills use `$VAULT_DIR` and `$NAV_DIR` env paths and reference scripts as `./vault-pipeline/scripts/…` not absolute paths. No researcher-specific content. `/consensus-check`'s quota state file path is `${CLAUDE_STATE_DIR:-~/.claude/state}/consensus-quota.json` — override via env var if your install uses a different state directory.

## Installation

After cloning:

```bash
cp -r claude-code-skills/* ~/.claude/skills/
```

For session context (who the agent is working with), copy `templates/scientific-identity-template.md` to `scientific-identity.md` somewhere your agent loads it. The filled-in version is gitignored.

For `/consensus-check` specifically, complete the one-time setup in [`docs/setup.md`](../docs/setup.md) → "Consensus.app integration" before first use.
