# Scientific Identity — TEMPLATE

> **This is a template, not a skill, not a workflow file.** It exists so an AI agent (Claude Code, Codex, Cursor, or anything else) knows who it's working with at the start of a science session — your role, lab, current work, terminology, collaboration style. Without this context, the agent has to ask basic background questions every conversation.
>
> **How to use it.** Copy this file to `scientific-identity.md` somewhere your agent will load it (project-local context, agent profile, system prompt — whatever your tool supports). Fill it in. The filled-in version is gitignored; the template stays so the structure is visible to anyone reading the repo.

---

## Who you are

One paragraph: your role, institution, lab name, and the central scientific contribution your lab is known for. Mention key methods, model systems, or discoveries that make your lab's perspective distinctive.

*Example shape (replace entirely):* "[Role] at [Institution]. Lab's defining contribution: [one-sentence discovery or research focus]. Long history of studying [topic]; recent work focuses on [current focus]."

## Lab narrative arc

Bullet list of your lab's key papers in chronological order — first author + year + journal + one-line finding. This gives the assistant the throughline of your scientific story so it doesn't ask you to re-explain context every session.

```
- Author 2018 (Journal) — first finding that shaped the trajectory
- Author 2020 (Journal) — extension or mechanism
- Author 2023 (Journal) — current state of the work
```

Five to ten entries is plenty.

## Institutional roles

If you wear multiple hats, list them. The assistant should know when "the lab" means just your group versus when you're acting as a center director, core lead, or institutional administrator.

- Role 1 — what it covers
- Role 2 — what it covers

## Lab personnel and key collaborators

Optional. If the assistant should recognize names that come up repeatedly, list them with one-line context. (Don't put anything here you're uncomfortable with the assistant having in its working context.)

## Active grant pipeline

A short list of grants in flight or in active planning, with one-line status. Keep this current — it's the easiest part to drift out of date.

```
- [Grant title] — [status] — [next deadline]
```

## Key search terms

A list of MeSH terms, gene/protein names, methods, or model systems that come up repeatedly in your work. The assistant uses these as starting points for vault and PubMed searches when a question is ambiguous.

```
- term 1
- term 2
- term 3
```

## Preferred journals

The journals you read most regularly and target most often. Helps the assistant prioritize when filtering search results.

```
- Journal 1
- Journal 2
- Journal 3
```

## Collaboration style

How you want the assistant to engage with you scientifically. The default in this repo is critical engagement — the assistant should evaluate ideas against the literature and flag problems directly, not validate by default. If your style differs, override here.

*Default text (edit or replace):* "I expect critical engagement, not agreement. During science brainstorming, evaluate ideas against the literature and flag problems (confounds, feasibility, logical gaps) directly. Do not default to validation. Behave like a co-PI reviewing a draft, not a trainee seeking approval."

---

*This file is read at the start of a science session, not during writing. Keep it factual and stable — drift here causes drift everywhere downstream.*
