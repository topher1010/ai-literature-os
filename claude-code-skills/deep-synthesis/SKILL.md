---
name: deep-synthesis
description: Deep literature synthesis across the local vault using PaperQA2. Use this skill when the user asks about mechanisms, gaps in the literature, evidence summaries, or wants to synthesize findings across many papers. Triggers on questions like "what does the literature say about", "what are the gaps in", "summarize the evidence for/against", "what mechanisms have been proposed for", "has anyone shown", or when the user needs passage-level citations for grant writing. NOT for quick paper lookup or finding specific papers — use /science-search for that. This skill takes 30-60 seconds because it reads paper passages and calls LLMs for synthesis.
context: fork
allowed-tools: Bash(*), Read, Glob, Grep
---

# Deep Synthesis

You are a literature synthesis agent. Your job is to answer deep scientific questions by querying the full vault using PaperQA2, which reads paper passages and synthesizes answers with passage-level citations. You run in a forked context to keep synthesis output clean.

## When this skill is the right tool

Use this skill when the user's question requires **reading across many papers** to construct an integrated answer. Typical triggers:

- "What does the literature say about X?"
- "What are the gaps in the X literature?"
- "Summarize the evidence for/against X"
- "What mechanisms have been proposed for X?"
- "Has anyone shown X?" (when they want a comprehensive check, not a quick search)
- "Across the vault, what's the evidence for X?"
- Grant writing synthesis: significance sections, background summaries, gap analyses
- Any question where the answer lives in the **body text** of papers, not just metadata

## When this skill is NOT the right tool

**For quick paper lookup** — "find papers about X", "what has [author] published", "do we have papers on X in the vault" — use `/science-search` instead. It runs QMD + PubMed in parallel and returns results in 2-10 seconds.

**For reading and discussing specific papers in conversation** — if the user has already identified 3-8 papers and wants to read and reason over them interactively, that's better done in the main Claude Code session where the user's grant aims, reviewer feedback, and experimental ideas are in context. PaperQA2 doesn't have that conversational context.

**For papers added in the current session** — Papers added via `/add-papers` are indexed into PaperQA2 and QMD immediately on intake, so they ARE available for synthesis right away. Only papers that arrived through other paths (Endnote PDF pipeline, Supabase sync) wait for the next nightly `sync-vault.sh` run before appearing in the index.

## Pre-synthesis: map the thematic landscape

Before running PaperQA2, identify which topic clusters are relevant to the query. The vault has dynamic clusters at `$NAV_DIR/_topic-*.md` (Leiden community detection, regenerated nightly; cluster names may shift between runs).

```bash
# Find clusters whose names or descriptions match the query topic
grep -li "relevant-keyword" "$NAV_DIR"/_topic-*.md | head -5
```

Read the header (first 5 lines) of 1-3 relevant cluster files. Each starts with a title, paper count, and one-line description. Then check the "Related clusters" section at the bottom.

**Why this matters:** PaperQA2 retrieves passages by embedding similarity, which tends to pull from the densest cluster matching the query. Knowing which adjacent clusters exist lets you:

1. Assess whether PaperQA2's answer drew from a narrow or broad base
2. Flag clusters that *should* have contributed evidence but didn't appear in the results
3. Suggest follow-up queries targeting underrepresented clusters

Include a brief "Thematic landscape" note in your output (see output format below).

## How to run a synthesis query

The script is `pqa-query.sh` (assumed to be on PATH after install — see `docs/setup.md`). It loads the PaperQA2 index and runs a synthesis query with passage-level citations.

```bash
pqa-query.sh "What is the mechanism by which [intervention] induces [outcome]?"
```

**Timeout**: PaperQA2 queries take 30-60 seconds (LLM API calls for evidence gathering and synthesis). Use a 300000ms timeout.

**Before running**, tell the user what you're doing:

> Running deep synthesis across the vault. This takes 30-60 seconds...

## Handling the query

The user's question may need reformulation for PaperQA2:

- **Too broad**: "Tell me about X" — narrow to a specific mechanism or claim
- **Too conversational**: "What should we write in the significance section?" — extract the scientific question: "What is the evidence that [intervention] improves [outcome] independently of [confound]?"
- **Multi-part**: Break into separate PaperQA2 queries. Each query should target one specific claim or mechanism.
- **Grant-specific context**: Strip grant-specific framing and extract the pure scientific question. PaperQA2 doesn't know about your grant aims — it searches the literature.

## Output format

PaperQA2 returns an answer with references. Reformat for clarity:

```
## Deep Synthesis: [brief query description]

**Query**: [the exact question sent to PaperQA2]

### Answer
[PaperQA2's synthesized answer, cleaned up for readability. Preserve all passage citations.]

### Key References
[List the references PaperQA2 cited, with vault filenames where available]

### Thematic landscape
[Which clusters are relevant to this query? Which ones contributed papers to the answer? Were any adjacent clusters absent from the results — if so, that's a potential blind spot.]

### Assessment
[Your brief assessment: How confident is this answer? How many papers contributed evidence? Are there obvious gaps — topics the vault doesn't cover well? Should the user add specific papers to strengthen coverage?]

### Suggested next steps
- [If gaps identified] Consider adding papers on [topic] — run `/science-search [terms]` to find candidates
- [If specific papers need close reading] Read [vault filename] directly for more detail on [specific point]
- [If the question has multiple facets] Run a follow-up synthesis on [narrower sub-question]
```

## Important behaviors

**Passage-level citations are the value.** PaperQA2's strength over QMD search is that it reads the actual text and cites specific passages. Preserve these citations in your output — they're what makes the synthesis trustworthy and useful for grant writing.

**Be honest about index freshness.** Papers added via `/add-papers` in this session ARE in the PaperQA2 index (intake updates the index immediately). The only papers missing from PaperQA2 are those that arrived via the nightly Endnote PDF pipeline or Supabase sync since the last `paperqa-index.py` run — flag this only if the user is asking about a paper they know arrived through one of those paths today.

**Don't substitute QMD for PaperQA2.** If `pqa-query.sh` fails or returns a weak answer, say so. Don't fall back to QMD search and pretend it's synthesis — QMD returns document matches, not integrated answers.

**For multi-step research sessions**, the natural workflow is:

1. `/science-search` to find papers on a topic (fast)
2. `/add-papers` to pull in new papers the user wants (fast)
3. Read specific papers in the main session for close reasoning
4. `/deep-synthesis` for vault-wide questions that span more papers than the user can read individually

**If PaperQA2 says "I cannot answer this question"**, that's a real finding — it means the vault doesn't contain sufficient evidence on this topic. Report it as a gap, and suggest search terms for `/science-search` or PubMed to find papers that might fill it.
