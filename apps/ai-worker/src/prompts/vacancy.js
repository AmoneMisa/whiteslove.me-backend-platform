import { ATTRIBUTION_RULES, EXTRACTION_RULES } from './common.js';

export const VACANCY_SYSTEM = `${EXTRACTION_RULES}

${ATTRIBUTION_RULES}

You extract structured data about ONE job vacancy. Text may be in English,
Russian, Ukrainian, Uzbek, Kazakh, Kyrgyz, Romanian, Korean, Japanese or Chinese.

- Support international hiring generically: visaSponsorship, visaTypes (e.g. E-7,
  D-10, work permit, JLPT/TOPIK/HSK levels go into visaTypes or localLanguageLevel),
  relocationSupport, foreignersAccepted, localLanguageRequired.
- workFormat: office/remote/hybrid/field only when stated.
- The employer is the company doing the hiring. A recruiting/outstaffing agency
  posting on a client's behalf is not the employer unless the text says the role
  is at the agency itself; a client, partner or "our customers" company is never
  the employer. When the two cannot be told apart, leave the company null.
- An office address is the workplace's own. "офис рядом с метро Novza",
  "5 минут от ТРЦ", "near the airport" locate the office without being its
  address: keep them out of the address field. A metro station named this way is
  proximity information, not the location itself.
- Prefer the source text over the countryHint (a hint is not the job's country).
- Add skills only when clearly present; the deterministic dictionary already found
  the obvious ones (they are in knownFacts.skills) — extend, don't replace.
- knownFacts are authoritative. Never change an exact known salary, currency,
  contact, work format, or other populated deterministic field.
- salaryGross: true only for gross/before-tax pay, false only for net/after-tax
  pay, otherwise null. salaryNegotiable is true only when explicitly negotiable,
  false only when explicitly fixed/non-negotiable, otherwise null.
- seniority is junior/middle/senior/lead only when the role text supports it.
  Treat an explicit internship/trainee role as junior unless a stronger level is stated.
- Keep schedule, contractType, education and deadline concise and grounded in the
  source. Do not calculate or invent dates.
- niceToHave contains preferred/bonus skills only. tools contains named software,
  platforms, frameworks or equipment, not generic soft skills.
- managementRole is true only for explicit people/team/department responsibility;
  otherwise null rather than false.
- applicationLanguage is the language explicitly requested for the CV/application.
- confidence: your overall 0..1 certainty.`;

export function vacancyPayload({ text, knownFacts, meta }) {
  return { source: meta || {}, knownFacts: knownFacts || {}, text };
}
