# Legal review items

> Decisions that need the operator and, ideally, legal advice. Code cannot
> settle them. Where a configuration variable records the decision,
> `npm run legal:check` reports the item as open until it is set.

| # | Question | Why it matters | Records the decision |
|---|---|---|---|
| 1 | **Is a Data Protection Officer required?** (Art 37(1)(b)) | Core activities may consist of regular and systematic monitoring of data subjects on a large scale. Being a natural person does not remove the requirement | `LEGAL_DPO_ASSESSMENT` = `not_required` / `appointed` |
| 2 | **Does any automated processing produce legal or similarly significant effects?** (Art 22) | Scores never trigger high-impact actions without a named reviewer, but listing-level public states and ranking could still affect advertisers | `LEGAL_ARTICLE22_ASSESSMENT` |
| 3 | **Is an EU representative needed?** (Art 27) | Romanian listings and users fall under GDPR via Art 3(2) if the operator is established outside the EU. The operator's establishment is not recorded in the repository | `LEGAL_ARTICLE27_ASSESSMENT` |
| 4 | **Governing law and jurisdiction for the Terms** | Must not be invented | `LEGAL_GOVERNING_LAW` |
| 5 | **Article 14 approach** | Advertisers, recruiters and candidates did not give us their data. Either notices are sent (manually — nothing sends messages automatically) or a disproportionate-effort exemption is documented with reasoning and the information is made public (Art 14(5)(b)) | `PRIVACY_ARTICLE14_APPROACH` |
| 6 | **Approve the DPIA and LIA** | Draft documents in this folder | `PRIVACY_DPIA_STATUS`, `PRIVACY_LIA_STATUS` |
| 7 | **Candidate profiles** | Whether aggregating CVs from other platforms is supportable, and removing `gender` and `age` | — |
| 8 | **Facebook crawling as a logged-in account** (`FACEBOOK_COOKIES`) | Conflicts with the documented public-only boundary and with "publicly accessible" provenance | Keep unset |
| 9 | **AI providers and international transfers** (Chapter V) | Which providers are enabled in production, whether their terms allow training on inputs, and the transfer mechanism for each | Update DATA_INVENTORY §5 |
| 10 | **Hosting provider and location, backups, log retention** | Needed for the privacy notice and Art 32 | Update DATA_INVENTORY §5 |
| 11 | **Retention periods** | Especially the 36-month classes | `PRIVACY_RETENTION_POLICY_APPROVED` |
| 12 | **Publishing the privacy contact address** | A personal mailbox on a public page is permanently scrapeable; a forwarding alias can be used instead | `PRIVACY_CONTACT_EMAIL` |
| 13 | **Supervisory authority named in the privacy notice** | The right to complain applies to the authority of the person's residence, work or the alleged infringement; which authorities to name depends on item 3 | Privacy notice text |
| 14 | **Reviewer authentication** | The admin API uses one shared key with a self-declared reviewer name; the audit trail is only as reliable as that name | — |
