---
name: consensus-check
description: EXPLICIT-INVOCATION-ONLY skill for querying Consensus.app (a paid academic search service with a free MCP tier over 200M+ papers). Invoke ONLY when the user (a) types the `/consensus-check` slash command, or (b) explicitly names "Consensus.app", "Consensus search", or "the Consensus tool" by product name. DO NOT invoke for general claim verification, fact-checking, evidence gathering, paper discovery, alternate search, or because the user said "consensus" in a generic sense (e.g. "what is the scientific consensus on X" — that is NOT a trigger). For those purposes use `/science-search` (paper discovery via vault + PubMed), `/deep-synthesis` (vault synthesis with passage citations), or `/critique` (adversarial review). Each invocation costs one query against a monthly MCP quota (30/month on the free tier) and is targeted at narrow, deliberate use during grant-writing or other high-stakes prose.
context: fork
allowed-tools: Read, Write, Bash(*), Grep, Glob, mcp__consensus__search, mcp__qmd__search
---

# Consensus Check

## Invocation rule (read this first)

**This skill is opt-in only by design.** It runs against a paid third-party service with a hard monthly quota, and burns external API budget. The shipped configuration treats it as explicit-invocation-only; if you prefer different defaults for your install, edit this frontmatter to widen the trigger phrases.

You may invoke this skill only if **one of the following is unambiguously true**:

1. The user typed `/consensus-check` as a slash command.
2. The user named the service explicitly — "Consensus.app", "Consensus search", "the Consensus tool", "run Consensus on this", "check this in Consensus" — referring to the **product**, not the concept of scientific consensus.

If the user asks any of the following, this skill is **NOT** the right tool — do not invoke it:

- "Is this claim supported?" / "is this defensible?" → `/science-search` or `/deep-synthesis`
- "What's the consensus on X?" / "do most studies agree?" → `/deep-synthesis` (the word "consensus" here means scientific agreement, not the product)
- "Find papers on X" / "what's published about Y" → `/science-search`
- "Check this before it goes out" / "critique this draft" → `/critique`
- "Verify this PMID" / "is this paper real" → direct PubMed lookup or `/science-search`

When in doubt, do **not** invoke this skill. The user will name the product if they want it.

## Setup (one-time)

Before this skill works, the host install needs:

1. A free Consensus.app account (sign up at https://consensus.app/sign-up).
2. The Consensus MCP server registered: `claude mcp add --transport http consensus https://mcp.consensus.app/mcp`.
3. OAuth completed on first use (a browser flow). Tokens land in `~/.claude/.credentials.json` and auto-refresh.
4. `mcp__consensus__search` added to the project's allowlist if you use one.

If any of those are missing, the first `mcp__consensus__search` call will fail or return degraded (no-account-tier, 3 results/search) output. See [`docs/setup.md`](../../docs/setup.md) → "Consensus.app integration" for the full walkthrough including OAuth-over-SSH gotchas.

## What this skill does

You are a claim-verification agent. Take a specific scientific claim from the user, query Consensus.app once, and return a structured verdict with supporting/contradicting evidence — plus a paste-ready handoff to `/add-papers` for any discoveries worth ingesting into the vault.

## Why this skill exists

`/science-search` covers paper discovery across the local vault and PubMed. `/deep-synthesis` covers passage-level synthesis over the curated vault. Neither answers **"is this specific sentence I want to put in a grant defensible against the broader literature?"** Consensus.app answers that, because it ranks against 200M+ papers including journals PubMed doesn't always surface (preprints, non-biomedical, gray journals).

**The one real use case** is **claim-defensibility checking during grant prose drafting.** The user has written (or is about to write) a sentence like "the literature broadly supports X" and wants a sanity check before committing it. The skill returns a verdict, the top supporting/qualifying papers, and an honest read on whether the claim is defensible as worded.

What this skill is **not for**, even when correctly invoked, and the right tool for each:

- Paper discovery → `/science-search`
- Synthesis over the curated vault → `/deep-synthesis`
- Adversarial review of a draft → `/critique`

## What you receive

The user should provide a **specific testable claim**. Examples of good input:

- "[Hormone X] administration increases [physiological outcome] in humans."
- "[Pathway Y] is required for [intervention]'s effect on [endpoint]."
- "[Intervention] shifts [neural signaling] in [brain region]."

Examples of bad input — push back and ask for a specific form before burning a query:

- "[Topic X]" (too broad — what about it?)
- "Is [intervention] good?" (not testable)
- "Tell me about [pathway]" (this is a topic, not a claim — use `/science-search` instead)

If the user's input is too broad, do **not** call the API. Tell them what you need and stop.

## Step 1: Pre-flight quota check

State file path: `${CLAUDE_STATE_DIR:-$HOME/.claude/state}/consensus-quota.json`. Schema:

```json
{
  "month": "YYYY-MM",
  "count": 0,
  "limit": 30,
  "warn_at": 24,
  "tier": "free-mcp"
}
```

Defaults match the Consensus.app free MCP tier (30 searches/month). Pro users should edit the state file to `"limit": 1000, "warn_at": 800, "tier": "pro"`. The file is hand-editable.

Run this block as a single bash invocation. It auto-creates the file if missing, resets the counter on a new month, and exports the relevant numbers for downstream checks:

```bash
STATE_DIR="${CLAUDE_STATE_DIR:-$HOME/.claude/state}"
STATE_FILE="$STATE_DIR/consensus-quota.json"
CURRENT_MONTH=$(date +%Y-%m)
mkdir -p "$STATE_DIR"

if [ ! -f "$STATE_FILE" ]; then
  printf '{"month":"%s","count":0,"limit":30,"warn_at":24,"tier":"free-mcp"}\n' "$CURRENT_MONTH" > "$STATE_FILE"
fi

STORED_MONTH=$(jq -r '.month' "$STATE_FILE")
if [ "$STORED_MONTH" != "$CURRENT_MONTH" ]; then
  jq --arg m "$CURRENT_MONTH" '.month = $m | .count = 0' "$STATE_FILE" > "$STATE_FILE.tmp" \
    && mv "$STATE_FILE.tmp" "$STATE_FILE"
fi

jq -r '"count=\(.count) limit=\(.limit) warn_at=\(.warn_at) tier=\(.tier)"' "$STATE_FILE"
```

Parse the output. Then:

- **If `count >= limit`**: refuse the query. Tell the user the cap was hit, suggest waiting until next month or upgrading. Do **not** silently fall back to `/science-search` — that's a different tool with different semantics. Stop here.
- **If `count >= warn_at`**: proceed, but include a warning in your final output: "⚠ Quota near cap: {count+1}/{limit} after this call".
- **Otherwise**: proceed silently.

## Step 2: Search Consensus (one call)

Call `mcp__consensus__search` exactly once. Map the claim into params:

- `query`: the claim verbatim (or a lightly rewritten search-friendly form — keep all key terms).
- `human: true` — set when the claim concerns humans. Skip for cell/animal-only claims.
- `exclude_preprints: false` — default; preprints are part of the value (they're what PubMed often misses).
- `year_min` — only set if the user explicitly mentioned recent/current literature.
- `study_types`, `sjr_max`, `medical_mode`, etc. — leave unset unless the user named a specific constraint.

If the call fails (network error, 429, OAuth not yet authorized): surface the error verbatim to the user. Do not retry, do not increment the quota counter, and do not fall back to another tool.

## Step 3: Vault dedup

For each returned paper that has a PMID, check whether the vault already has it. Two viable approaches — pick the lighter one based on how many PMIDs came back:

**Approach A (≤10 PMIDs)**: one `grep` across the vault:

```bash
grep -lE '^pmid: (12345678|87654321|11111111)$' "$VAULT_DIR"/*.md 2>/dev/null
```

**Approach B (>10 PMIDs or PMID lookup failed)**: use `mcp__qmd__search` against the configured collection with the PMID as the query.

Papers returned by Consensus with only a DOI (no PMID — often preprints or non-PubMed journals) cannot be cheaply deduped against the vault. Mark them `[new]` and let `/add-papers` handle dedup at intake time.

**Known limitation**: at the time of writing, Consensus's free and authenticated tiers return only Consensus internal paper URLs in the API response, not PMIDs or DOIs. The `/add-papers` handoff is therefore not push-button at those tiers — you must resolve identifiers via PubMed on demand for any specific paper the user wants ingested. The skill's PubMed resolution step (below) addresses this.

## Step 4: PubMed resolution for identifiers (only on user request)

If the user wants any of the new papers added to the vault, resolve PMIDs via `mcp__pubmed__pubmed_search` using author + year + a distinctive title fragment. Only resolve papers the user actually wants — don't bulk-resolve all 10.

## Step 5: Increment quota (only after a successful call)

After the Consensus call succeeded and you have results in hand, increment:

```bash
jq '.count = .count + 1' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
NEW_COUNT=$(jq -r '.count' "$STATE_FILE")
LIMIT=$(jq -r '.limit' "$STATE_FILE")
```

If the call failed for any reason, **do not** increment.

## Output format

```
## Consensus check: [claim verbatim]

### Verdict (N papers reviewed)
Supporting: X · Mixed/Inconclusive: Y · Contradicting: Z
[One-sentence interpretation — Strong support / Mixed evidence / Weak or sparse / Field is divided / etc. Be honest, not generous.]

### Top supporting (up to 5)
- **Author Year** — One-sentence claim-relevant finding. [PMID: 12345678 — resolve on request] [in vault | new]

### Top contradicting / mixed (up to 5)
- **Author Year** — One-sentence why this qualifies or contradicts the claim. [PMID: 87654321 — resolve on request] [new]

### Coverage vs. vault
N of M papers are already in the vault. K papers are new.

### Add to vault?
Consensus's response does not include PMIDs/DOIs at the free/authenticated tier. If you want any of the new papers ingested, name them and I'll resolve identifiers via PubMed (no Consensus quota cost), then format for `/add-papers`.

### Quota
Used: {new_count} / {limit} this month ({month}, tier: {tier})
```

Adjust sections that don't apply — e.g., if all results support the claim, write "No contradicting evidence in this result set" rather than omitting it (the absence itself is informative).

## Pairing with `/critique`

Three of `/critique`'s eight failure modes are good candidates for upstream-to-this-skill chaining when the user explicitly invokes the pairing:

- `single_paper_synthesis` — claim is anchored on one paper but framed as field-level
- `single_source_contrarian` — claim runs against field consensus with one citation
- `confidence_without_convergence` — confident phrasing not backed by multiple sources

The other five `/critique` failure modes (`wrong_pmid`, `cross_domain_leap`, `exceeds_cited_evidence`, `coverage_gap`, `abstract_vs_fulltext`) are resolved internally by `/critique` and chaining to Consensus wastes quota.

Cap at 3 Consensus queries per `/critique` session. Each chained query must still be invoked explicitly by the user — `/critique` itself does not auto-recommend Consensus.

## Important behaviors

**Critical engagement, not agreement.** If Consensus returns mostly contradicting evidence, lead with that — don't bury it. If results are sparse (3-4 weak hits), say "Field is sparsely studied" — don't inflate.

**Broad claim → refuse the call.** Topics like "[Hormone] and metabolism" cost a query for almost no signal. Push back and ask for a specific testable form. Mention that `/science-search` is the right tool for topic exploration.

**One query per invocation.** Don't reformulate and re-query in the same skill run. The quota is small and the user invoked the skill expecting one targeted check.

**No auto-handoff to /add-papers.** Print the identifiers (after PubMed resolution if needed) grouped for easy copy-paste, but never invoke `/add-papers` yourself. The user picks which discoveries are worth ingesting.

**No silent fallback.** If the Consensus call fails or the quota is exhausted, say so plainly. Do not silently route to `/science-search` — that's a different tool answering a different question.

**Vault path is `$VAULT_DIR`** from the environment. If the env var is unset, fall back to the host install's documented vault location; do not invent a path.

**Tier behavior**: The shipped defaults (`limit: 30`, `warn_at: 24`) reflect Consensus.app's free MCP tier. Pro users (1,000 searches/month) should edit the state file. If the API starts returning 429 well before the local counter says cap was hit, surface the error and suggest editing the state file's `limit` down.

**Silent no-auth fallback**: Consensus accepts unauthenticated requests as "no account" tier (3 results/search, unlimited searches) and never returns 401. If responses include "showing top 3", OAuth has dropped — re-authorize via `claude mcp` UI.
