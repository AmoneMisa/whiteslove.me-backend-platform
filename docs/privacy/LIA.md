# Legitimate-interests assessment

> DRAFT for legal review. Covers the purposes marked LI in
> [LEGAL_BASIS_MATRIX.md](LEGAL_BASIS_MATRIX.md). Approval is recorded as
> `PRIVACY_LIA_STATUS=approved`. Three-part test: purpose, necessity, balancing.

## A. Listing aggregation and contact actions (P1, P2, P7)

**Purpose.** Housing and job listings are scattered across marketplaces,
Telegram channels, social groups and small websites. Aggregating them helps
people find housing and work. The advertisers published the listings,
including their contact, in order to be contacted.

**Necessity.** The contact must be shown for the listing to be useful; it is
the purpose for which it was published. Nothing beyond the published listing
is collected for this purpose. AI enrichment receives the text with contacts
redacted.

**Balancing.** Advertisers reasonably expect a public advertisement to be
seen and contacted, and aggregators of public listings are a familiar
practice in these markets. Impact is low: the same information is already
public at the source. Risk arises when a listing is removed at the source but
remains here; mitigated by the listing lifecycle and snapshot retention.

**Safeguards.** Source link retained; removed listings leave the public feed;
objection and erasure through `/data-rights`; retention periods.

**Provisional conclusion:** interest likely not overridden.

## B. Listing integrity: clones, phantoms, reposts (P3)

**Purpose.** Protect renters from phantom listings, bait-and-switch and
advance-fee fraud, and protect honest advertisers whose photos and listings
are copied. Fraud prevention is recognised as a legitimate interest in
Recital 47.

**Necessity.** Detecting a clone requires comparing listings and their
history; detecting phantom inventory requires availability observations over
time. Less intrusive alternatives (showing listings without history) cannot
detect either pattern.

**Balancing.** Public states describe the *listing* ("availability
uncertain", "appears repeatedly"), not the person, and are recomputed as
evidence changes. False positives are the main harm; mitigations are
thresholds requiring independent properties, false-positive tests for honest
patterns (popular flats renting fast, landlords with several flats, agencies),
and exclusion of disputed evidence from public states.

**Provisional conclusion:** interest likely not overridden, subject to the
safeguards remaining enforced.

## C. Identity resolution, identity history and risk profiling (P4, P5, P6)

**Purpose.** Fraud often relies on rotating names, accounts and phone numbers.
Recognising the same actor across them is what makes the pattern visible.

**Necessity.** Identity links are made only on strong identifiers (the same
phone, the same platform id); a display name alone never merges actors.
Identity history is limited to 12 months.

**Balancing — this is the part that needs legal review.** This processing is
**systematic monitoring** and **profiling** of people who did not provide the
data and may not expect a history of their names and numbers to be kept or
scored. Harms: wrongful association (a reused phone number), wrongful merging
of two people, stigma from an internal label, and difficulty contesting
something the person cannot see. Reasonable expectations are weaker than for
A and B.

**Safeguards implemented.**
- Evidence is internal; no identity or payment risk is ever published (§35).
- High-impact actions (blacklisting, removing access, hiding all listings,
  publishing allegations) require evidence confirmed by a named reviewer;
  no score substitutes (`authorizeIntegrityAction`).
- Every score comes with its reasons; dismissed evidence stays visible.
- Legacy registry labels are weak evidence (0.35) and never published.
- Access requests disclose the profiling reasons (Art 15(1)(h)); disputes keep
  contested evidence out of external use while open; the audit trail records
  who decided what.
- Retention per class; nothing kept indefinitely.

**Transparency.** No individual notices; public notice under Art 14(5)(b)
([ARTICLE14_EXEMPTION.md](ARTICLE14_EXEMPTION.md)).

**Safeguards still required before go-live.** Public privacy notice and
data-rights page published (done); objection flag honoured end-to-end (done,
DPIA R10); DPIA approved.

**Provisional conclusion:** **undetermined** until the DPIA is completed. Do
not enable identity or risk features on this LIA alone.

## D. Candidate profiles and deduplication (P8, P9)

**Purpose.** Help employers find candidates who published CVs to be found.

**Necessity.** Profile fields are those the candidate published. `gender` and
`age` are kept by operator decision, as published by the candidate at the
source; they are never inferred.

**Balancing.** A CV is published to be found by employers, but usually on a
specific platform under its privacy settings. Republishing it elsewhere, and
keeping it after it is removed at the source, goes beyond what the candidate
likely expects. Profiles from public search snippets (LinkedIn) are weaker
still.

**Provisional conclusion:** **undetermined.** Following source removal
promptly (deleted six months after last seen at the source) is the main
safeguard.

## E. Security logging (P13)

Standard and low-impact, provided logs are kept briefly and not used for
other purposes. Container logs rotate at 3 × 10 MB per service. **Provisional
conclusion:** not overridden.
