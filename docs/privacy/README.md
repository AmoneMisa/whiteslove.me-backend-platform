# Privacy and legal documentation

> **Status: DRAFT for operator and legal review. Not legal advice.**
> These documents describe the system as it exists in this repository on the
> `improvement` branch (September 2026). They were written from the code, not
> from assumptions. Where a fact cannot be established from the code (hosting
> location, which AI providers are enabled in production, the operator's
> jurisdiction), it is marked **OPERATOR INPUT** rather than guessed.

Primary source: Regulation (EU) 2016/679 (GDPR). Articles referenced: 5, 6,
12–22, 25, 27, 30, 32–35, 37 and Chapter V.

| Document | Purpose | Status |
|---|---|---|
| [DATA_INVENTORY.md](DATA_INVENTORY.md) | What personal data exists, where it comes from, where it goes (Art 30 record, cookie audit) | Draft |
| [LEGAL_BASIS_MATRIX.md](LEGAL_BASIS_MATRIX.md) | One legal basis per processing purpose, never a blanket basis (Art 6) | Draft |
| [LIA.md](LIA.md) | Legitimate-interests assessment for purposes relying on Art 6(1)(f) | Draft — `PRIVACY_LIA_STATUS` |
| [DPIA_DRAFT.md](DPIA_DRAFT.md) | Data protection impact assessment for identity and risk features (Art 35) | **Draft — not complete** — `PRIVACY_DPIA_STATUS` |
| [RETENTION_POLICY_DRAFT.md](RETENTION_POLICY_DRAFT.md) | Retention per data class (Art 5(1)(e)) | Draft — `PRIVACY_RETENTION_POLICY_APPROVED` |
| [LEGAL_REVIEW_ITEMS.md](LEGAL_REVIEW_ITEMS.md) | Decisions that need the operator and legal advice | Open |

## How approval is recorded

Approval is configuration, checked by `npm run legal:check` in `apps/flats`
and by the `deploy.sh` preflight. With `IDENTITY_FEATURES_ENABLED=true` the
deploy refuses to proceed until every item is recorded. Nothing in these
documents approves itself.

## Operator

The operator is a **natural person**, not a company. Company registration
number, registered office and tax id therefore do not exist and are not
requested. The operator's name and privacy contact are configured through
`PRIVACY_CONTROLLER_NAME` and `PRIVACY_CONTACT_EMAIL` and are deliberately not
written into this repository.
