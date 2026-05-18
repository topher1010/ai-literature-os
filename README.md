# ai-literature-os

## An intro note from Chris

This project represents an ongoing effort to take advantage of a core strength of LLMs; to read, summarize, and interact with a large amount of text.  In addition, more recent models and harnesses (Claude Code & OpenClaw for me) have opened the door for automated, agentic, multi-step tooling. In thinking about how I can best take advantage of these capabilities, engaging with the scientific literature was an obvious choice.

The project began with two separate goals: 1) To develop an automated approach for monitoring new publications and preprints. The vision was for the LLM to read 300 abstracts a week, and find the 10 that were most interesting to me. This led to the concept of the research-digest website.  2) To develop a method in which an LLM can assist me in reading, summarizing, and brainstorming over a large literature. The vision was for a system in which the LLM could brainstorm research ideas and gaps with me, but do so in a way that is based on a curated set of publications, not just its training data. I wanted the LLM to know my literature, so I started with my  Endnote library of  ~1000 papers, but it has continued to grow from there. Focusing on this goal led to the science vault.  More recently, I realized these two goals were connected, and now new publications identified via the research-digest can be directly embedded into the science vault for summarization and brainstorming.

I want to acknowledge up front that, except for this section, almost every word in this repo (text or code) was written by an LLM. While I cannot code, I had a vision for what I wanted, and then iterated until I got something that worked.  I have primarily used Claude Code, with Codex serving as an additional reviewer/perspective.  It continues to be a work in progress, and I have some additional feature ideas, as well as occasional bugs to squash. Yet I thought it might be at a point where others might find some value. If I can vibe code it, so can you.

Finally, this isn't a turn key system or something I am actively supporting. I am using it and will continue building, and if I add something or catch a major problem in my own workflow, I will try to update this repo.  But I am open to ideas and suggestions, so send me an email:
contact@tophertech.org

## Overview

This system is a coordination layer that uses modern AI tools — [QMD](https://github.com/tobi/qmd), [PaperQA2](https://github.com/Future-House/paper-qa), [Docling](https://github.com/DS4SD/docling), [OpenRouter](https://openrouter.ai/), and an LLM-driven coding agent — to interact with the scientific literature. It digests new papers, curates a personal evidence vault, and supports deep synthesis with passage-level citations. None of the individual pieces are novel; the value is in how they're wired together as a single working system.

The initial component is the **Research Digest**, viewable at [research-digest.tophertech.org](https://research-digest.tophertech.org/). This is the live deployment of Chris's personal manuscript discovery system (Vercel + Supabase, weekly cron) running against a curated research profile embedding. Source for the deployed pipeline is in [`research-digest/`](https://github.com/topher1010/ai-literature-os/blob/main/research-digest).

This is a **reference implementation, not a maintained product** — shared so others can fork and adapt it. **Writing is yours**: the system surfaces and synthesizes evidence; it does not draft prose for you.

This was built on [Claude Code](https://docs.claude.com/en/docs/claude-code), and the `claude-code-skills/` and `claude-code-agents/` folders show the skill and agent definitions actually in use. The underlying architecture (vault + navigation layer + QMD + PaperQA2 + cron) is agent-agnostic — Codex, Cursor, or a custom agent could play the same role.

## What's in the box

A richer Mermaid diagram with data-flow direction and store boundaries lives at the top of [`ARCHITECTURE.md`](ARCHITECTURE.md).

```
              ┌─────────────────────────────┐
              │   research-digest pipeline  │  weekly: PubMed + bioRxiv + NIH
              │   (PubMed → score → store)  │  scoring against your profile
              └──────────────┬──────────────┘
                             │ (selected papers promoted to vault)
                             ▼
   ┌───────────┐    ┌────────────────────────────────────┐
   │  source   │───▶│         vault-pipeline             │
   │  PDFs +   │    │ Docling → enrich (PubMed/PMC) →    │
   │  PMIDs    │    │ LLM-tag → embed (OpenRouter) →     │
   └───────────┘    │ Leiden cluster + neighbor sidecar  │
                    └──────────────┬─────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
       ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐
       │ QMD search   │   │  PaperQA2    │   │   agent layer   │
       │ (BM25 + vec) │   │  synthesis   │   │ (CC skills shown)│
       └──────────────┘   └──────────────┘   └─────────────────┘
                                                     │
                                                     ▼
                                       (you, doing science)
```

| Component | What it does | Public maturity |
|---|---|---|
| **`vault-pipeline/`** | Convert, enrich, tag, embed, and index a personal markdown vault. Includes the QMD patches that route embeddings through OpenRouter and fix a vec0 crash. | Most reusable. Adapt by swapping research keywords and source paths. |
| **`research-digest/`** | Weekly PubMed + bioRxiv + NIH Reporter polling, Claude scoring against your researcher profile, database storage, web frontend for triage. Run-scoped artifacts; fail-closed scoring; tests. | Usable reference implementation. Live deploy uses Vercel + Supabase; the pipeline is decoupled — any host and database will work. |
| **`claude-code-skills/`** | The Claude Code skills in use (`/science-search`, `/deep-synthesis`, `/add-papers`, `/critique`, and the optional `/consensus-check`). Forked context keeps large search results and verification chatter out of the main session. | Drop-in if you use Claude Code; `/consensus-check` requires a Consensus.app account. Otherwise a worked example of how an agent might use the vault. |
| **`claude-code-agents/`** | The vault-librarian agent (Tue/Fri 4 AM): audits pipeline health, hash-churn, cluster quality, digest-run reports. | Template for a cron-scheduled health agent in any system. |
| **`templates/`** | `scientific-identity-template.md` — copy, fill in, and load at the start of any science session so your agent knows who it's working with. | Useful with any agent runtime. |
| **`cron/`** | Example crontab covering all schedules. | Copy what you want. |

## What's NOT in the box

This is tooling, not content or judgment. The repo deliberately omits:

- Vault content (papers, PDFs, summaries)
- The PaperQA2 index artifact (~hundreds of MB; build your own)
- A research profile embedding (build from your own seed papers)
- A scientific identity (lab, grants, collaborators — yours)
- API keys, project IDs, deployments
- The most important part: scientific interpretation, taste, hypothesis generation, grant strategy, and final claims. Those stay with the scientist.

See [`docs/whats-not-included.md`](docs/whats-not-included.md) for the full list and rationale.

## Quickstart

This is **not** a one-command install. The pipeline depends on Claude Code, [Bun](https://bun.sh), Python ≥3.11, an OpenRouter account, and (for the digest) a database + frontend host.

1. **Read [`ARCHITECTURE.md`](ARCHITECTURE.md)** end-to-end. The system has hard invariants (Pipeline Contract) — violating them costs real money in re-embedding.
2. **Read [`docs/responsible-use.md`](docs/responsible-use.md).** NIH and most journals have explicit policies about AI use in grants and manuscripts. The repo follows them; your usage should too.
3. **Follow [`docs/setup.md`](docs/setup.md)** to install QMD at the pinned commit, apply the patches, install Docling + PaperQA2 in a venv, copy `.env.example` to `~/.config/ai-literature-os.env`, and run a first sync against a tiny test vault (3 PMIDs is enough).
4. **Customize** per [`docs/customization.md`](docs/customization.md) — research topics, journal list, NIH institute filter, scientific identity template.
5. **Wire up the cron** from [`cron/example-crontab`](cron/example-crontab).

The first useful output is a small enriched vault you can search with `/science-search` and synthesize with `/deep-synthesis`. The research digest takes longer because it needs a database and frontend host.

## Upstream contributions

Three local patches against [QMD](https://github.com/tobi/qmd), each against a real failure mode rather than a feature request. They live in [`vault-pipeline/qmd-patches/`](vault-pipeline/qmd-patches/) and are applied to a pinned upstream commit:

- **OpenRouter transport with fail-loud semantics** — routes embeddings through the OpenAI-compat API and aborts on outage instead of silently falling back to a local model that produces incompatible vectors.
- **vec0 UNIQUE-constraint handling** — fixes an over-broad catch that hid dimension-mismatch and marshaling errors. Tracked upstream as [tobi/qmd#558](https://github.com/tobi/qmd/issues/558).
- **vec0 refuse-DROP-on-dim-mismatch** — blocks a silent-wipe pattern. Requires explicit `QMD_ALLOW_VEC_RECREATE=1` for legitimate model migrations.

After any `bun update -g qmd`, re-apply both patches — the install will otherwise revert to vanilla QMD's silent-fallback behavior, which is worse than failing.

## Adapting it to your research area

Most adaptation happens in gitignored files so a fork won't accidentally publish your customizations. Things you'll need to change:

- **Researcher profile** — one-sentence description of your role and focus, set in `.env` as `RESEARCHER_PROFILE`.
- **Digest configs** — copy `research-digest/pipeline/config/*.example.json` to `*.json` and edit search queries, journal sweeps, NIH institute filters.
- **Digest prompts** — copy `research-digest/pipeline/prompts/*.example.txt` to `*.txt` and tune scoring + summary prompts to your researcher profile.
- **Seed papers** — copy `research-digest/pipeline/data/seed-pmids.example.json` to `seed-pmids.json` and populate with your representative papers (Core / Methods / Adjacent buckets), then run `build-profile.js` once.
- **Scientific identity** — copy `templates/scientific-identity-template.md` to `scientific-identity.md`, fill it in (role, lab, current grants, key terms, preferred journals), and load it at the start of any science session. Gitignored.

See [`docs/customization.md`](docs/customization.md) for the full walkthrough and a fresh-adoption checklist.

## Citation

If this work informs a paper, talk, or course, please cite via [`CITATION.cff`](CITATION.cff) — GitHub renders a "Cite this repository" widget in the sidebar. A methods paper describing the system is in preparation; the citation will be updated to point at it once published.

## Author

**Chris Morrison** — Research scientist (nutritional neuroscience) and executive at Pennington Biomedical Research Center.

- https://www.tophertech.org
- https://www.linkedin.com/in/christopher-morrison-4b3315369/

## License

[MIT](LICENSE). The pipeline depends on QMD (MIT) and PaperQA2 (Apache-2.0) — both compatible.
