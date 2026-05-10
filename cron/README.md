# `cron/`

Example crontab covering all scheduled jobs in the system. Copy what you want into your own crontab; ignore what you don't.

```
cron/
└── example-crontab    # All schedules, with comments — uncomment what you want
```

## Schedule overview

| Schedule | Job |
|---|---|
| Daily midnight | Vault pipeline: convert → dedup → enrich → integrate → re-embed → relate → cluster → re-index |
| Daily 1 AM | Other-collection re-embed (must run *after* vault sync — see Pipeline Contract item 5 in [`ARCHITECTURE.md`](../ARCHITECTURE.md)) |
| Daily 7 AM | Git backup of scripts and skill configs |
| Tue/Fri 4 AM | Vault librarian: health check |
| Sunday 4 AM | Research digest: poll → score → store |

## Critical ordering

Any other-collection re-embed cron **must** run *after* the vault re-embed cron. The QMD `--collection` flag is silently ignored upstream ([tobi/qmd#558](https://github.com/tobi/qmd/issues/558)); ordering is the only enforcement.

If your timezone or run-frequency preferences differ, edit accordingly — but preserve the ordering invariant.
