# Article 14: public notice instead of individual notices

> **Operator decision (September 2026):** no individual notices are sent to
> people whose data comes from public sources. This page documents the
> reasoning and the safeguards the exemption requires. Draft for legal review.

## Decision

The service is a scraper of public sources. Advertisers, recruiters and
candidates are not contacted individually to tell them their public data has
been collected. The operator relies on the exemption in **Article 14(5)(b)**:
providing the information would involve a disproportionate effort.

## Reasoning

- **Scale.** Listings, vacancies and profiles arrive continuously from many
  sources across five countries. Individual notices would mean messaging a
  large and constantly changing population.
- **No usable channel for many subjects.** Plenty of records hold only a
  username or a display name; there is no address to send a notice to.
- **Contacting would itself be intrusive.** The only channel for most people
  is the phone number or messenger handle they published for a specific
  advertisement. Unsolicited messages to every advertiser would be more
  intrusive than the processing, and bulk messaging these contacts is
  something the service rules out anyway.
- **Low marginal value.** The data was published by the person for public
  view, and the core use (showing their listing to people looking for
  housing or work) matches why they published it.

## Safeguards (required by Art 14(5)(b) for the exemption to hold)

1. **Public information.** The privacy notice at `/privacy` and `/en/privacy`
   describes the Article 14 information: categories of data, sources, purposes,
   legal basis, legitimate interests, recipients, transfers, retention,
   profiling, and rights.
2. **Easy exercise of rights.** `/data-rights` lets anyone ask what is held,
   correct it, object, restrict or dispute it, with verification limited to
   proving control of the identifier.
3. **Minimal public exposure.** Identity history and risk evidence stay
   internal; public pages show only listing-level states.
4. **Retention limits** per [RETENTION_POLICY_DRAFT.md](RETENTION_POLICY_DRAFT.md).
5. **Objections honoured** once received (DPIA R10 must be implemented).

## Effect on the system

- `PRIVACY_ARTICLE14_APPROACH=exemption_documented` records the decision.
- `platform.article14_notices` stays available but unused for routine
  processing; it remains useful if a particular case (for example, a person
  whose data a reviewer is acting on) calls for a notice.
- **Where the exemption is weakest:** risk evidence and identity history go
  beyond what an advertiser expects from publishing an advertisement. If a
  high-impact action is ever taken against a person, informing them at that
  point is recommended even though routine notices are not sent.
