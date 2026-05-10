# `templates/`

Per-user files that you copy and fill in. They are **not** skills, **not** part of the pipeline, and **not** wired up automatically. They exist so you have a starting structure when you sit down to write your own version.

```
templates/
└── scientific-identity-template.md   # Session context for any AI agent
```

## How to use

1. Copy a `*-template.md` to your filename of choice (drop the `-template` suffix).
2. Fill it in.
3. Load it into your agent however your tool supports — Claude Code project context, Cursor rules, a system-prompt block, etc.
4. The filled-in version is gitignored, so you can keep it next to the template without it leaking into a fork.

## What lives here vs. what doesn't

The repo deliberately does **not** ship a writing-persona template, an "AI writing patterns to avoid" reference, or any other writing-assist scaffolding. The system is for finding and synthesizing evidence; writing is yours. If you want a writing skill in your own private setup, build one — but consider [NIH AI policy](https://grants.nih.gov/) and your target journal's policy first.

`scientific-identity-template.md` is here because every agent benefits from knowing who it's working with at the start of a session. It is not about writing.
