# What's not in the box

This repo is **tooling**. It is not content, judgment, or your scientific identity. The omissions below are deliberate — they are the parts only you can build.

## Content the repo deliberately omits

### Vault content

No papers, PDFs, summaries, or extracted text. The vault is yours to populate. The `add-paper.py` script and the Endnote PDF workflow are how you fill it.

If you want to test the system end-to-end before building a real vault, follow the demo path in [`docs/setup.md`](setup.md): three public PMIDs is enough to exercise the full intake → enrichment → embedding → search loop in under five minutes.

### PaperQA2 index

The `.pkl` index is hundreds of MB once a real vault is built. It is not committed to git — building one is part of setup. The first build takes a while (proportional to vault size and to your network bandwidth for embedding); subsequent runs are incremental on body-text sha256.

### Researcher profile (digest scoring)

The research digest scores incoming papers against a profile embedding built from your seed papers. The shipped `build-profile.js` script builds this; the resulting `embeddings/profile.json` is gitignored. Run it once with a few dozen of your most-cited or most-relevant papers as seeds.

### Scientific identity

`templates/scientific-identity-template.md` is a stub with section headers describing what should go in it: your role, lab, current grants, key collaborators, central scientific commitments, preferred journals, collaboration style. **Do not commit your filled-in version.** The `.gitignore` blocks `scientific-identity.md` so a personalized copy stays local.

### Lab / institution / collaborator references

The shipped scripts have no hardcoded names, surnames, journal-specific lab filters, or institution paths. The pipeline knows about your work only through:

- Your `.env` (`RESEARCHER_PROFILE`, paths)
- Your filled-in `scientific-identity.md`
- The seed papers you use to build your digest profile
- Your digest config files (`journals-config.json`, `grants-config.json`)

### API keys and service IDs

No keys. No Supabase project IDs. No Vercel deployment URLs. `.env.example` lists the variable names; the values are yours to provide.

## Capability the repo deliberately omits

### Lab-data analysis

This is a **literature** OS. It does not handle bench data, statistics, image analysis, sequencing, mass spec, or any kind of experimental data processing. There are good tools for those (Jupyter, R, ImageJ, Galaxy, snakemake) — this repo is not one of them.

### Experimental design

No protocol generation, no sample-size calculators, no randomization. The system can summarize what's been tried in the literature; it cannot design your next experiment.

### Lab notebook

No ELN. No PI dashboard. No multi-user permissions. This is a single-user system; if you and a postdoc both want to use it, you each run your own copy.

### Project management

No tasks, no deadlines, no Gantt charts. The vault stores evidence; project management lives in whatever tool you already use (Obsidian, Notion, paper, sticky notes).

### Writing — at all

The system does not draft prose. No manuscript generation, no author-list construction, no Specific Aims drafts, no first-pass paragraphs from a one-line prompt. The shipped skills are scoped to find, retrieve, and synthesize evidence with passage-level citations; the writing is yours. See [`responsible-use.md`](responsible-use.md).

## Why these are omitted

A few are practical (the vault content, the keys — those are obviously yours). But several are deliberate **scope refusals**:

- **No data analysis** keeps the system focused. A literature OS that also did bench data would be a lab platform, which is a much bigger product than one researcher's tooling.
- **No writing assistance** keeps the system aligned with NIH and journal policies and avoids the "AI ghostwriter" framing. The system helps you find evidence; what you do with it is your authorial work.
- **No turnkey demo experience** is a values choice. The system rewards investment. A scientist who runs through setup, builds their own vault, and customizes the scoring will get a useful tool. A scientist looking for a one-click product should look elsewhere — the system isn't trying to be that.

## What if I just want to try it?

Reasonable. Follow [`docs/setup.md`](setup.md) → "Tiny demo path." Three public PMIDs, a one-paragraph researcher profile, no Supabase. About 30 minutes from clone to first `/science-search` query against a real (tiny) vault. That's enough to feel the shape of the system before deciding whether to invest more.
