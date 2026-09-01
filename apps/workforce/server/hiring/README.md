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
