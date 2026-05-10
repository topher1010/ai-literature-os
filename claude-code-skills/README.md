# `claude-code-skills/`

Three [Claude Code skills](https://docs.claude.com/en/docs/claude-code/skills) that I happen to use. Each runs in forked context to keep search results out of the main session.

> **Agent-agnostic note.** These specific files are Claude Code's skill format — slash commands, frontmatter, allowed-tools. The *operations* they wrap (vault search, deep synthesis, paper intake) are general; another agent runtime would need its own equivalents but would do the same work against the same vault and nav layer.

```
claude-code-skills/
├── science-search/      # Fast vault + PubMed search (2-10 sec)
├── deep-synthesis/      # PaperQA2 vault-wide synthesis (30-60 sec)
└── add-papers/          # PMID/DOI/bioRxiv intake; updates QMD + PaperQA2 immediately
```

## Routing

- `/science-search` — to **find** papers
- `/deep-synthesis` — for **integrated answers** across many papers
- `/add-papers` — to **import** new ones (auto-indexed)

The three cross-reference each other and suggest the alternative when appropriate (a search question routed to `/deep-synthesis` will redirect to `/science-search`, and vice versa).

**No writing skill is shipped here.** This repo helps you find, organize, and synthesize evidence; the writing is yours. If you want a writing-assist skill in your own private setup, build one — but consider [NIH AI policy](https://grants.nih.gov/) and your target journal's policy first.

## How sanitization was done

The shipped skills use `$VAULT_DIR` env paths and reference scripts as `./vault-pipeline/scripts/…` not absolute paths. No researcher-specific content.

## Installation

After cloning:

```bash
cp -r claude-code-skills/* ~/.claude/skills/
```

For session context (who the agent is working with), copy `templates/scientific-identity-template.md` to `scientific-identity.md` somewhere your agent loads it. The filled-in version is gitignored.
