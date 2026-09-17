# Data protection impact assessment

> **DRAFT — NOT COMPLETE.** Prepared for operator and legal review before
> production rollout of identity and risk features. It must not be treated as
> approved until the operator records `PRIVACY_DPIA_STATUS=approved` after
> review. Scope, risks and measures below reflect the code; likelihood and
> severity ratings are proposals.

## 1. Why a DPIA is needed

Article 35(3) and the EDPB criteria point clearly to a DPIA:
- **systematic monitoring** of people through public sources over time;
- **profiling** with risk evaluation (integrity scores);
- **data not obtained from the subject**, often without their awareness;
- **matching and combining datasets** (listings, social profiles, the legacy
  registry);
- potentially **large scale** (multiple countries and sources).

## 2. Processing described

See [DATA_INVENTORY.md](DATA_INVENTORY.md) §3.2–3.4 and
[LEGAL_BASIS_MATRIX.md](LEGAL_BASIS_MATRIX.md) P3–P6, P8–P9. In short: contacts
from public listings are grouped into actors on strong identifiers; usernames
and names are tracked over time; listing history, clones and availability
outcomes become reason-coded risk and trust evidence; six integrity dimensions
are scored; reviewers confirm or dismiss evidence; only listing-level states
may be public.

## 3. Necessity and proportionality

- Purposes are specific (fraud and clone detection); see LIA.
- Minimisation: strong identifiers only; no special-category data; contacts
  redacted from AI extraction prompts; payment signals store the match
  offset, never card numbers; access responses withhold unverified linked
  contacts.
- Accuracy: independent-evidence thresholds; false-positive tests; disputes.
- Storage limitation: per-class retention, gated on approval.
- Transparency: public notice under the Art 14(5)(b) exemption, no
  individual notices (operator decision, [ARTICLE14_EXEMPTION.md](ARTICLE14_EXEMPTION.md)).
- Rights: request workflow, verification, restriction, objection, disputes.

## 4. Risks

Likelihood (L) and severity (S): low / medium / high. Proposed, for review.

| # | Risk | Area | L | S | Measures in place | Residual / still needed |
|---|---|---|---|---|---|---|
| R1 | People are profiled without knowing it | Public-source collection, Art 14 | High | High | Operator decision: Art 14(5)(b) exemption with documented reasoning; public privacy notice and data-rights page | Publish `/privacy` and `/data-rights` (Stage I); the exemption does not hold without them |
| R2 | Two people wrongly merged into one actor | Identity graph | Medium | High | Merges only on strong identifiers; never on name; access responses withhold unverified linked contacts and report it; `wrong_identity_merge` dispute leads to a manual split | Reused/recycled phone numbers remain a source of false merges; consider an age limit on phone-based links |
| R3 | Wrong phone linked to a person | Contact intelligence | Medium | Medium | Only valid numbers stored; provenance kept; dispute type `wrong_phone_association` | — |
| R4 | False-positive risk evidence harms an honest advertiser | Risk profiling | Medium | High | Thresholds on independent properties; false-positive tests (small landlords, agencies, fast rentals, evergreen hiring); trust evidence collected; nothing published about persons; high-impact actions need named-reviewer confirmation; disputed evidence excluded from external use | Reviewer guidance and training; periodic sampling of confirmed evidence |
| R5 | Legacy spreadsheet labels treated as fact | Registry import | Medium | High | Imported as internal evidence only; low weight; never published; conflicts create review cases rather than merging | Operator to review legacy labels whose basis is unknown |
| R6 | Personal data sent to AI providers, possibly used for training or transferred abroad | Processors, Chapter V | High | Medium | Contacts redacted from extraction prompts | **Translation text is not redacted; photos are sent to vision providers.** Confirm enabled providers, their data-use terms and transfer mechanisms; implement placeholder redaction for translation; consider excluding photos showing people or documents |
| R7 | Historical usernames and names retained longer than useful | Identity history | Medium | Medium | 12-month retention draft | Approve retention |
| R8 | Unauthorised access to internal evidence or identity graph | Security | Low | High | Dedicated admin key (not the crawler key), no-store responses, PII-free error logs, audit trail of every decision | Per-reviewer credentials instead of a shared key with a self-declared reviewer name; database access review; backups encryption — OPERATOR INPUT |
| R9 | Photo processing drifts into biometric identification | Special categories | Low | High | Perceptual hashing of listing photos for clone detection only | Keep a written prohibition on face recognition; test that candidate photos are never fingerprinted |
| R10 | Objection or restriction recorded but not honoured | Rights | High | Medium | Flags stored and audited; the integrity layer excludes evidence marked `processingRestricted` or `underDispute` from public states and high-impact actions | **Nothing yet loads the flags onto evidence, and ingestion does not check them.** Must be wired before identity features are enabled |
| R11 | Cross-platform linkage reveals more than each source alone | Identity graph | Medium | Medium | Links internal only; public UI limited to summaries (§59) | Decide which summaries, if any, are public |
| R12 | Candidate data used to discriminate | CV aggregation | Medium | High | `gender` and `age` kept by operator decision, only as published by the candidate, never inferred | Accepted by the operator |
| R13 | Crawling behind a login (Facebook cookies) | Collection | Low | Medium | Social fetcher boundaries documented as public-only | Keep `FACEBOOK_COOKIES` unset |

## 5. Automated decision-making (Art 22)

No decision with legal or similarly significant effect is taken solely by
automated means: high-impact actions require named-reviewer confirmation, and
public states describe listings, are reversible and can be disputed. Whether
listing-level states or ranking effects could nonetheless amount to a
similarly significant effect is **open for legal review**
(`LEGAL_ARTICLE22_ASSESSMENT`).

## 6. Consultation

- Data subjects' views: not sought. Consider feedback through the dispute flow.
- DPO: none appointed; requirement open (Art 37).
- Prior consultation with a supervisory authority (Art 36): required if high
  residual risk remains after measures. **Cannot be assessed until R1, R6 and R10
  are addressed.**

## 7. Outcome

**Not complete.** Identity and risk features should not be enabled in
production until R1, R6 and R10 are resolved, this document is reviewed,
and `PRIVACY_DPIA_STATUS=approved` is recorded.
