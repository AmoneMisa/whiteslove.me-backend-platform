# CV domain

This directory is the candidate/CV bounded context. The historical folder name
`hiring` is retained temporarily to keep imports and persisted contracts stable.

## Sections

- `application/` — candidate refresh and read-model use cases.
- `domain/` — pure candidate classification and normalization rules.
- `infrastructure/` — PostgreSQL, locks and persistence adapters.
- `sources/` — Telegram, web, social and LinkedIn candidate adapters.

Public APIs return normalized candidate DTOs. Consumers must not reinterpret
raw source roles, salaries, locations or personal facts. Source adapters do not
own crawler execution policy.

## Where the candidate list lives (`HIRING_STORE`, `HIRING_READ_STORE`)

- `snapshot` (default): the candidate list is one JSON value (`hiring:store:v4` in the state store, ~280 MB). Every
  crawl, every web source and every AI result reads and parses it, merges, serialises and writes it back, and the
  search index is rebuilt from the whole list each time. The CV worker's heap sits close to its limit because of it.
- `HIRING_STORE=postgres`: the `candidates` table is the store, as it already is for the feed. A crawl writes only the
  candidates it carries (`saveDbCandidates`); the AI state of those already stored is read back by key and reused when
  the text is unchanged; an AI result updates one row (`upsertDbCandidates`); the search index is told about just those
  (`indexCandidatesIncremental`, which never sweeps) and reconciled against the table every six hours. The AI state,
  `lastSeen`, `derived` and `visible` live in `candidates.data`, which keeps whatever the profile carries. Retention is
  the table's (`pruneDbCandidates`). The JSON value is still produced from the table, in pieces, at most every
  `HIRING_SNAPSHOT_EXPORT_MIN_INTERVAL_SECONDS` (300), for the readers that use it and for switching back.
- `HIRING_READ_STORE=postgres`: share previews read the table. The feed already does, with the snapshot only as its
  fallback. Independent of the writer: the table is current in either mode.

Differences to know when switching: `persistTelegramCandidates` returns the number of candidates this crawl kept, not
the size of the whole store; a web crawl's `expired` counts what it brought that was already outside the window.
Switching back is `HIRING_STORE=snapshot` and a recreate; the exported value is at most a few minutes behind.

