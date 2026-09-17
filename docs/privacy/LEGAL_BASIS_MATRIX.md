# Legal-basis matrix

> DRAFT for legal review. One basis per purpose; there is no blanket basis.
> Retention references are to [RETENTION_POLICY_DRAFT.md](RETENTION_POLICY_DRAFT.md).
> Transfers reference [DATA_INVENTORY.md §5](DATA_INVENTORY.md).

Legend — **LI**: legitimate interests, Art 6(1)(f), assessed in [LIA.md](LIA.md).
**Contract**: Art 6(1)(b). **Legal obligation**: Art 6(1)(c).
**Automated decision**: whether the purpose involves a decision based solely on
automated processing (Art 22).

| # | Purpose | Data categories | Data subjects | Source | Basis | Legitimate interest | Retention | Recipients | Transfers | Automated decision |
|---|---|---|---|---|---|---|---|---|---|---|
| P1 | Aggregate and search public housing listings | Listing text, photos, advertised contact, source URL | Advertisers | Public listings | LI | Helping people find housing across fragmented sources; advertisers published to reach renters | Live while listed; snapshots 12 months | Site visitors; AI providers (redacted text, photos) | AI providers — OPERATOR INPUT | No |
| P2 | Show advertiser contact actions (call, Telegram, etc.) | Advertised contact | Advertisers | Public listings | LI | Connecting renters with the advertiser, the purpose for which the contact was published | As P1 | Site visitors | — | No |
| P3 | Detect cloned, phantom and repeatedly reposted listings | Listing history, photo fingerprints, availability outcomes | Advertisers | Public listings, probes, user reports | LI | Protecting renters from fraud and wasted journeys; protecting honest advertisers from copies | 12 months | Internal; listing-level public states only | — | No — public states describe the listing and are reversible; reviewed per §36 |
| P4 | Actor identity resolution and identity history | Contacts, usernames, display names, bios, roles over time | Advertisers, recruiters | Public listings and profiles | LI | Recognising the same advertiser across channels and renamed accounts, which fraud relies on | Aliases 12 months; contacts 18 months unobserved | Internal only | — | No |
| P5 | Risk and trust evidence, integrity scores (**profiling**) | Reason codes, evidence detail, review decisions | Advertisers, recruiters | Derived from P1–P4, registry, reports | LI | Fraud prevention (Recital 47) | 6–36 months by review state | Internal only | — | **Open** — scores alone never trigger high-impact actions (enforced in `authorizeIntegrityAction`); Art 22 assessment pending, LEGAL_REVIEW_ITEMS §2 |
| P6 | Import the legacy Google registry | Names, phones, aliases, notes, risk/trust labels | Advertisers | Operator's own spreadsheet | LI | Continuity of the operator's existing fraud notes | 18 months unless corroborated | Internal only; labels never published automatically | Google (processor) | No |
| P7 | Aggregate vacancies | Company, recruiter contact, vacancy text | Recruiters | Public job boards | LI | Helping job seekers find vacancies | While live + retention TBD | Site visitors; AI providers | As P1 | No |
| P8 | Aggregate candidate profiles | CV data (see inventory §3.4) | Candidates | Public job sites, public search snippets | LI — **needs particular scrutiny** | Helping employers find candidates who published CVs to be found | 6 months after last seen at source | Site visitors; AI providers | As P1 | No |
| P9 | Deduplicate candidate profiles | Email, phone, Telegram id, social id | Candidates | As P8 | LI | Avoiding duplicate and conflicting profiles of one person | As P8 | Internal | — | No — never merges on name |
| P10 | Telegram search subscriptions | Telegram id, chat id, username, first name, saved searches | Subscribers | The subscriber | Contract | Not applicable | 30 days after the last subscription is removed; 12 months with only paused subscriptions | Telegram | Telegram | No |
| P11 | Handle privacy requests and disputes | Requester email, identifiers, request text, decisions | Requesters, subjects | The requester | Legal obligation (Arts 12–21) | Not applicable | 36 months after closure (review) | Internal | — | No |
| P12 | Review audit trail | Reviewer name, decision, note | Reviewers, subjects | Internal | Legal obligation (Art 5(2) accountability) and LI | Demonstrating how decisions about people were made | 36 months (review) | Internal | — | No |
| P13 | Security and abuse prevention on the website and API | IP address (in memory for rate limiting; logs) | Visitors | Visitors | LI | Keeping the service available and resisting scraping and floods | Container logs rotated, 3 × 10 MB per service | Hosting provider | OPERATOR INPUT | No |
| P14 | Remember language, theme and UI state | Cookie and localStorage values | Visitors | Visitors | Necessary for a requested feature (ePrivacy) + LI | Remembering choices the visitor made | Cookie lifetime; local storage until cleared | None (stays in the browser) | — | No |
| P15 | Article 14 notices | Actor's contact, notice status | Advertisers, recruiters, candidates | Derived | Legal obligation (Art 14) | Not applicable | With the actor record | Internal | — | No |

## Right to object

Every LI purpose (P1–P9, P13) is subject to the Art 21 right to object.
Implemented: `platform.actor_identities.processing_objection_at` recorded via
`POST /api/admin/privacy/restrictions` (`kind: objection`), and honoured in the
identity repository used by ingestion, in scoring, in listing lines and in
owner collections — see DPIA R10.
