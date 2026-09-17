# Data inventory (record of processing)

> DRAFT. Written from the code on the `improvement` branch. Article 30 record
> of processing activities in substance; see [README](README.md) for status.

## 1. Controller

| Field | Value |
|---|---|
| Controller | The operator, a natural person — configured as `PRIVACY_CONTROLLER_NAME` |
| Contact for privacy matters | Configured as `PRIVACY_CONTACT_EMAIL` |
| DPO | None appointed. Whether one is required is open — see LEGAL_REVIEW_ITEMS §1 |
| EU representative | Open — see LEGAL_REVIEW_ITEMS §3 |

## 2. Data subjects

| Group | How they appear | Given data to us directly? |
|---|---|---|
| Advertisers of housing (owners, realtors, agents) | Name, phone, messenger handles, profile names in public listings | **No** — Article 14 applies |
| Recruiters and employers | Company, recruiter name and contacts in public vacancies | **No** — Article 14 applies |
| Job candidates | CV profiles from public job sites and public search snippets | **No** — Article 14 applies |
| People named in the legacy Google registry | Names, phones, aliases, operator notes, risk/trust labels | **No** — Article 14 applies |
| Site visitors | IP address in server logs; language and theme cookies; local browser storage | Yes (Article 13) |
| Telegram subscribers | Telegram user id, chat id, username, first name, language, saved searches | Yes (Article 13) |
| Privacy requesters | Email, identifiers they claim, request text | Yes (Article 13) |

## 3. Personal data by processing activity

### 3.1 Listing aggregation (flats)

- **Sources:** OLX, Telegram channels, public Facebook pages/groups, owner and
  realtor websites, custom sites a user submits for crawling (`apps/flats/src/scrapers`,
  `src/sources`). Countries: RO, UA, KZ, UZ, KG.
- **Data:** listing title/description (free text that may contain names and
  contacts), photos, price, location, the advertised phone or Telegram handle
  (`listings.data`, `platform.contact_points`), source URL, timestamps.
- **Storage:** PostgreSQL (`flats`, `platform` schemas), Elasticsearch (listing
  search index), photos proxied/cached by the site.
- **Recipients:** public website visitors (listings and advertised contacts
  are shown as published by the advertiser); AI providers (§5).

### 3.2 Contact and identity intelligence (Stages C–E)

- `platform.contact_points`: canonical phone/handle, raw form, origin, source
  URL, whether publicly accessible, first/last seen.
- `platform.actor_identities`, `actor_contact_points`, `actor_roles`: grouping
  of contacts into actors and the roles they were observed in.
- `platform.platform_identities` and `platform_identity_observations`:
  usernames, display names and bios over time (**identity history**).
- `platform.listing_snapshots`, `listing_availability_observations`,
  `property_clusters`, `listing_lineage`: listing history, availability
  outcomes, clone/repost relationships.
- `platform.actor_edges`, `actor_evidence`: identity graph and risk/trust
  evidence with reason codes (**profiling**, Art 4(4)).
- **Recipients:** internal only. Public pages may show only the listing-level
  states defined in `integrity-scores.js` (`listing_availability_uncertain`,
  `listing_appears_repeatedly`, `source_information_inconsistent`). No identity
  or payment risk is published.

### 3.3 Legacy registry import (Stage B)

- Google Sheet "Flat Finder Internal Registry", read-only, via a service account.
- Tables `platform.registry_*`: clusters, identifiers (phones, aliases), sources,
  evidence, review cases, import runs.
- Hard blacklist and high-risk labels are imported as **internal evidence only**
  (weight 0.35 in scoring) and never published automatically.
- Not yet run in any environment (service account not configured).

### 3.4 Jobs and CVs (apps/workforce)

- **Vacancies:** company, title, location, salary, description, recruiter and
  application contacts. Adapters exist for hh, hh.kz, headhunter.kg, rabota.kz,
  enbek.kz, work.ua, robota.ua, djinni.co, ejobs.ro, bestjobs.eu, LinkedIn
  (public guest endpoints), Telegram, Facebook, Threads.
- **Candidates:** name, handle, role, city, remote preference, experience,
  salary expectations, skills, languages, sectors, description, source URL —
  **and `gender` and `age` columns** (see §7).
- `candidate_identity_keys`: email, phone, Telegram id, social id used for
  deduplication.
- **Recipients:** website visitors of the hiring pages; AI providers (§5).

### 3.5 Telegram subscriptions (apps/subscription-bot)

- `users`: Telegram user id, chat id, username, first name, language.
- `subscriptions`, `deliveries`, `subscription_seen`: saved searches and which
  items were sent. `edit_sessions`, `handoffs`: short-lived tokens (30 min TTL).
- **Recipients:** Telegram (message delivery).

### 3.6 Privacy requests and review (Stages G–H)

- `platform.privacy_requests`: requester email, claimed and verified
  identifiers, request text, outcome.
- `platform.dispute_cases`, `article14_notices`, `review_audit_events`:
  disputes, notice worklist, reviewer names and notes.
- **Recipients:** internal only.

### 3.7 Website (Personal-Site)

- **Server:** client IP used in memory for rate limiting translation requests
  (`server/utils/requestClientIp.ts`); not stored by the application. Reverse
  proxy and container logs: **OPERATOR INPUT** — confirm what is logged and
  for how long.
- **Cookies:** see §6.
- **Third-party requests from the browser:** map tiles from
  `tile.openstreetmap.org` (the visitor's IP and requested map area reach the
  OpenStreetMap Foundation).

## 4. Special-category data

Not intentionally collected, and nothing derives it. Residual risks:
free-text listings and CVs can mention religion, health or nationality, and
**candidate photos** are images of people. Photos are not used for biometric
identification: `perceptual-hash.py` fingerprints listing photos for clone
detection, not faces. This must stay true — see DPIA risk R9.

## 5. Processors and third parties

| Recipient | What it receives | Role | Transfer |
|---|---|---|---|
| Hosting provider | Everything | Processor | **OPERATOR INPUT** — provider and location |
| AI gateway (self-hosted FreeLLMAPI) routing to configured providers: Groq, Google Gemini, NVIDIA, Hugging Face, LLM7, OpenRouter, Mistral, Cloudflare Workers AI, optional Apinex | Listing/vacancy/CV **text with contacts redacted** (`apps/ai-worker/src/util/privacy.js`); **translation requests are not redacted**; listing **photos** for vision | Processor (subject to each provider's terms) | Mostly US-based — **OPERATOR INPUT**: which providers are enabled in production, their data-use terms (free tiers may train on inputs), and the Chapter V mechanism for each |
| Valhalla routing (public endpoint by default) | Coordinates of listings and metro stations | Third party | No personal data sent |
| OpenStreetMap tile servers | Visitor IP, map area | Independent controller | From the visitor's browser |
| Telegram | Subscription messages | Independent controller | — |
| Google (Sheets API) | Read requests from the service account | Processor for the registry sheet | — |
| Source platforms (OLX, Facebook, Threads, LinkedIn, job boards) | Crawl requests | Independent controllers | — |

## 6. Cookie and storage audit (Personal-Site)

Audited `nuxt.config.ts`, `app/**`, `server/**`. **No analytics, advertising,
tracking pixels or third-party cookies were found.**

| Name | Type | Set by | Purpose | Lifetime | Necessary? |
|---|---|---|---|---|---|
| `i18n_lang` | Cookie | @nuxtjs/i18n | Remembers chosen language | Module default | Functional preference requested by the user |
| `nuxt-color-mode` | Cookie + localStorage | Inline head script | Colour theme | 1 year | Functional preference |
| `flats:*`, jobs/hiring search state, presets, recently viewed, quiz answers, markdown-editor drafts | localStorage | Pages | Saves the user's own UI state in their browser | Until cleared | Functional; never sent to the server |

Conclusion: only strictly necessary and user-requested preference storage is
used. Under the ePrivacy rules this generally does not require a consent
banner, and **no banner should be added just to have one** (§55). A cookie
notice page describing the table above is appropriate. If analytics are ever
added, this audit and the consent requirement must be revisited first.

## 7. Findings requiring action

1. **Candidate `gender` and `age`** are kept by operator decision
   (LEGAL_REVIEW_ITEMS §7) and are listed in the privacy notice.
2. **Translation requests send unredacted text** (including phone numbers) to
   AI providers, because the prompt must preserve contacts in the output.
   Recommend placeholder substitution with restoration — DPIA R6.
3. **`FACEBOOK_COOKIES`** in `.env.example` allows crawling as a logged-in
   account, contradicting `services/social-fetcher/README.md` ("No account
   login, cookies"). Crawling behind a login is harder to reconcile with
   "publicly accessible source" provenance and with Facebook's terms.
   Recommend leaving it unset — LEGAL_REVIEW_ITEMS §8.
4. **Vision sends listing photos** to external providers; photos can show
   people, documents or number plates — DPIA R6.
5. **Log retention** is not configured in the repository — RETENTION_POLICY_DRAFT.
