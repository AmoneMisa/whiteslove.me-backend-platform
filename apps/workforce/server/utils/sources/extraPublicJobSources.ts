import { parseHiringVacancySalary } from '@whiteslove/parsing-lexicon/hiring-salary-context'
import { detectUsLocation } from '@whiteslove/parsing-lexicon/hiring-source-semantics'
import type { Job, SponsorshipConfidence } from '~~/shared/contracts/jobs'
import { detectWorkModes } from '../hiring/hiringLexicon'
import { absoluteHttpUrl as absoluteUrl, decodeHtmlEntities, stripHtml } from '../support/htmlText'

export type PublicBoard = {
  label: string
  url: string
  /** Country the listing belongs to when the board is national. */
  country?: string
  remoteByDefault?: boolean
  usOnly?: boolean
  assumeUs?: boolean
  sponsorshipConfidence?: SponsorshipConfidence
  sponsorshipEvidence?: string
}

export type FlagmaJobBoardDescriptor = Pick<PublicBoard, 'label' | 'url' | 'country'>

// Flagma parsing stays here as source-specific markup knowledge. Its execution
// is owned by the community-board queue target and the shared cyclic/detail
// crawler policy.
const FLAGMA_VACANCY_LINK_RE =
  /<a\b[^>]*href="([^"]*flagma\.[a-z]{2}\/(?:ru\/)?vakansiya-[^"?#]*-rv\d+\.html)"[^>]*>([\s\S]*?)<\/a>/gi

/** Card markup as rows, because each row of a Flagma card means something. */
function cardLines(fragment: string): string[] {
  return decodeHtmlEntities(fragment)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|span|td)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

export function parseFlagmaVacancies(html: string, board: FlagmaJobBoardDescriptor): Job[] {
  const jobs: Job[] = []
  const seen = new Set<string>()
  const matches = [...html.matchAll(FLAGMA_VACANCY_LINK_RE)]

  for (const [index, match] of matches.entries()) {
    const url = match[1]!
    if (seen.has(url)) continue
    seen.add(url)

    // The card runs to the next link for a *different* vacancy: a card holds
    // several anchors to the same posting, and stopping at the first of them
    // would cut off the employer and location rows that follow the title.
    const start = Math.max(0, (match.index ?? 0) - 200)
    const nextDistinct = matches.slice(index + 1).find((candidate) => candidate[1] !== url)
    const end = nextDistinct?.index ?? Math.min(html.length, (match.index ?? 0) + 2_000)
    // The shared stripHtml flattens a document to one line, which is right for
    // the generic boards and useless here: this card's meaning is in its rows.
    const lines = cardLines(html.slice(start, end))

    const title = stripHtml(match[2] || '') || lines[0] || ''
    // "Коваленко О.А., ФЛП" then "| Полтава, UA" — the employer and where it
    // is, which the card may put on one row or two.
    const employerRowIndex = lines.findIndex((line) => /\|\s*[^|]+,\s*[A-Z]{2}\s*$/.test(line))
    const employerRow = employerRowIndex >= 0 ? lines[employerRowIndex]! : ''
    const inlineEmployer = employerRow.includes('|') ? employerRow.split('|')[0]!.trim() : ''
    const employerPart = inlineEmployer
      || (employerRowIndex > 0 ? lines[employerRowIndex - 1]!.replace(/[|,]+$/, '').trim() : '')
    const locationPart = employerRow.replace(/^[^|]*\|/, '').trim()
    // "в Бухаресте, полная занятость" — where the work is.
    const placementLine = lines.find((line) => /^(?:в|у|in)\s+\p{Lu}/u.test(line)) || ''

    const text = lines.join(' ')
    const cleanTitle = title.replace(/\s+/g, ' ').trim()
    if (cleanTitle.length < 3 || cleanTitle.length > 180) continue

    jobs.push({
      id: `flagma-${url.match(/-rv(\d+)\.html/)?.[1] || url.slice(-24)}`,
      title: cleanTitle,
      company: employerPart || board.label,
      // "в Бухаресте, полная занятость" -> "Бухаресте". The city keeps the
      // grammatical case the site prints; declining it back is not worth a
      // dictionary, and the string is only ever displayed.
      location: placementLine
        .replace(/^(?:в|у|in)\s+/iu, '')
        .replace(/,\s*(?:полная|частичная|неполная)\s+занятость.*$/iu, '')
        .replace(/,\s*удал[ёе]нно.*$/iu, '')
        .trim()
        || locationPart
        || board.country
        || '',
      url,
      source: 'companies',
      remote: detectWorkModes(text).includes('remote'),
      postedAt: new Date().toISOString(),
      description: lines.slice(0, 8).join(' · ').slice(0, 600),
      tags: [board.label, ...(board.country ? [board.country] : [])],
    } as Job)
  }

  return jobs
}

// The pay sits in one visible row ("7 500 000 - 12 000 000 сум"), while the
// microdata beside it carries a single `value`. Reading that attribute alone
// collapsed every range onto its first number and left the period unknown, so
// the row goes to the shared vacancy salary parser, which owns ranges, periods
// and the country fallbacks (UZ quotes monthly pay, RO too).
const FLAGMA_SALARY_MICRODATA_RE = /<[^>]*\bitemprop=["'](?:value|minValue|maxValue|currency)["']/iu
const FLAGMA_BLOCK_BOUNDARY_RE = /<\/?(?:div|p|li|tr|td|table|h[1-6]|section|br)\b[^>]*>/i

function flagmaSalaryRow(html: string): string {
  const at = html.search(FLAGMA_SALARY_MICRODATA_RE)
  if (at < 0) return ''
  // Keep to the row the microdata sits in: the amount can be printed before the
  // marked-up span, the currency word after it, and neither crosses a block tag.
  const before = html.slice(Math.max(0, at - 400), at).split(FLAGMA_BLOCK_BOUNDARY_RE).pop() || ''
  const after = html.slice(at, at + 600).split(FLAGMA_BLOCK_BOUNDARY_RE)[0] || ''
  return stripHtml(`${before}${after}`).replace(/\s+/g, ' ').trim()
}

/** Board country: the listing says it, else the national domain does. */
function flagmaCountry(summary: Job, location: string): string | undefined {
  return location.match(/,\s*([A-Za-z]{2})\s*$/)?.[1]?.toUpperCase()
    || summary.country
    || summary.url.match(/flagma\.([a-z]{2})\b/i)?.[1]?.toUpperCase()
}

function flagmaSalary(
  html: string,
  summary: Job,
  location: string,
): Pick<Job, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod'> {
  const country = flagmaCountry(summary, location)
  const parsed = parseHiringVacancySalary(flagmaSalaryRow(html), {
    country,
    currencyFallback: 'country',
    periodFallback: 'country',
  })
  // The row is found by scanning the whole page for the *first* itemprop=value
  // node, which is also how schema.org marks up unrelated PropertyValue facts
  // (schedule, experience, etc.). A row that only reads as salary because
  // "Оплата труда"-style wording happened to sit in its 400/600-char window,
  // with no currency actually named next to the number, is that false match
  // (e.g. "9:00" from a work-hours line) rather than real pay — require the
  // currency to be explicit in the row itself, not a country-level guess.
  if (!parsed || (parsed.min == null && parsed.max == null) || parsed.currencySource !== 'explicit') {
    return {
      salaryMin: summary.salaryMin,
      salaryMax: summary.salaryMax,
      salaryCurrency: summary.salaryCurrency,
      salaryPeriod: summary.salaryPeriod,
    }
  }
  return {
    salaryMin: parsed.min ?? parsed.max ?? undefined,
    salaryMax: parsed.max ?? parsed.min ?? undefined,
    salaryCurrency: parsed.currency?.toUpperCase() || summary.salaryCurrency,
    salaryPeriod: (parsed.period as Job['salaryPeriod']) || summary.salaryPeriod,
  }
}

export function parseFlagmaVacancyDetail(html: string, summary: Job): Job | null {
  const canonical = absoluteUrl(
    html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/iu)?.[1] || summary.url,
    summary.url,
  )
  const heading = stripHtml(
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1] || '',
  )
  const title = stripHtml(
    html.match(/["']title["']\s*:\s*["']([^"']+)["']/iu)?.[1] || heading,
  )
  const description = stripHtml(
    html.match(/<div\b[^>]*id=["']description-text["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/iu)?.[1] || '',
  )
  if (!canonical || !title || title.length > 240 || description.length < 40) return null

  const company = stripHtml(
    html.match(/<div\b[^>]*id=["']company-title["'][^>]*>[\s\S]*?<a\b[^>]*>[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>/iu)?.[1] || '',
  ) || summary.company
  const location = stripHtml(
    html.match(/<span\b[^>]*class=["'][^"']*\bterr\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/iu)?.[1] || '',
  ) || summary.location
  const datePosted = html.match(/["']datePosted["']\s*:\s*["']([^"']+)["']/iu)?.[1]
  const salary = flagmaSalary(html, summary, location)
  const employmentType = html.match(/["']employmentType["']\s*:\s*["']([^"']+)["']/iu)?.[1]
  const semanticText = `${title}\n${location}\n${description}`

  return {
    ...summary,
    id: `flagma-${canonical.match(/-rv(\d+)\.html/i)?.[1] || summary.id.replace(/^flagma-/, '')}`,
    title,
    company,
    location,
    url: canonical,
    remote: detectWorkModes(semanticText).includes('remote'),
    postedAt: validDate(datePosted || summary.postedAt),
    employmentType: employmentType || summary.employmentType,
    description: description.slice(0, 4_000),
    ...salary,
  }
}

export const PUBLIC_JOB_BOARDS: PublicBoard[] = [
  { label: 'Remote Source', url: 'https://www.remotesource.com/jobs', remoteByDefault: true },
  { label: 'TaskFavour', url: 'https://www.taskfavour.com/jobs' },
  { label: 'Tech Leads Community', url: 'https://techleadscommunity.com/', remoteByDefault: true },
  { label: '4 Day Week', url: 'https://4dayweek.io/jobs' },
  { label: '80,000 Hours', url: 'https://jobs.80000hours.org/' },
  { label: 'Welcome to the Jungle', url: 'https://www.welcometothejungle.com/en/jobs' },
  { label: 'Working Nomads', url: 'https://www.workingnomads.com/', remoteByDefault: true },
  { label: 'Remote.co', url: 'https://remote.co/remote-jobs', remoteByDefault: true },
  { label: 'Virtual Vocations', url: 'https://www.virtualvocations.com/jobs/', remoteByDefault: true },
  { label: 'Jobspresso', url: 'https://jobspresso.co/jobs/', remoteByDefault: true },
  { label: 'Wellfound', url: 'https://wellfound.com/jobs' },
  { label: 'Dice', url: 'https://www.dice.com/jobs?location=&q=' },
  { label: 'Built In', url: 'https://builtin.com/jobs/remote/software-engineering', usOnly: true, assumeUs: true },
  { label: 'Y Combinator', url: 'https://www.ycombinator.com/jobs/role/software-engineer/united-states', usOnly: true, assumeUs: true },
  { label: 'TechFetch', url: 'https://www.techfetch.com/', usOnly: true, assumeUs: true },
  { label: 'PowerToFly', url: 'https://powertofly.com/jobs/?location=USA', usOnly: true, assumeUs: true },
  { label: 'SimplyHired', url: 'https://www.simplyhired.com/' },
  { label: 'Escape the City', url: 'https://www.escapethecity.org/search/jobs' },
  { label: 'Diversity Jobs Group', url: 'https://diversityjobsgroup.com/job-listings/' },
  {
    label: 'VisaJobSearch',
    url: 'https://www.visajobsearch.com/jobs',
    usOnly: true,
    sponsorshipConfidence: 'verified',
    sponsorshipEvidence: 'Visa-focused board labels roles with sponsorship status',
  },
  {
    label: 'VisaJobFinder',
    url: 'https://visajobfinder.com/usa',
    usOnly: true,
    assumeUs: true,
    sponsorshipConfidence: 'explicit',
    sponsorshipEvidence: 'Board states listed US roles explicitly offer visa sponsorship',
  },
  {
    label: 'JobsH1B',
    url: 'https://jobsh1b.com/jobs',
    usOnly: true,
    assumeUs: true,
    sponsorshipConfidence: 'historical',
    sponsorshipEvidence: 'Employer has H-1B sponsorship history; role eligibility is not guaranteed',
  },
  {
    label: 'VisaHire',
    url: 'https://visahire.co/',
    usOnly: true,
    assumeUs: true,
    sponsorshipConfidence: 'verified',
    sponsorshipEvidence: 'Board checks listing sponsorship intent or recent H-1B sponsor history',
  },
  {
    label: 'Migrate Mate',
    url: 'https://migratemate.co/visa-sponsorship-jobs',
    usOnly: true,
    assumeUs: true,
    sponsorshipConfidence: 'verified',
    sponsorshipEvidence: 'Visa-focused US board backed by employer sponsorship history',
  },
  {
    label: 'MyVisaJobs',
    url: 'https://www.myvisajobs.com/Search_Visa',
    usOnly: true,
    assumeUs: true,
    sponsorshipConfidence: 'historical',
    sponsorshipEvidence: 'Employer sponsorship history from US visa/LCA data',
  },

  { label: '10up', url: 'https://10up.com/', remoteByDefault: true },
  { label: '15Five', url: 'https://www.15five.com' },
  { label: '17hats', url: 'https://www.17hats.com/', remoteByDefault: true },
  { label: '18F', url: 'https://18f.gsa.gov' },
  { label: '1Password', url: 'https://www.1password.com' },
  { label: '42 Technologies', url: 'https://www.42technologies.com/', remoteByDefault: true },
  { label: 'abiturma', url: 'https://www.abiturma.de/' },
  { label: 'Ably', url: 'https://www.ably.io/' },
  { label: 'Abstract API', url: 'https://www.abstractapi.com', remoteByDefault: true },
  { label: 'acct', url: 'https://acct.global', remoteByDefault: true },
  { label: 'Acivilate', url: 'https://acivilate.com/' },
  { label: 'Acquia', url: 'https://www.acquia.com/', remoteByDefault: true },
  { label: 'ActiveCampaign', url: 'https://www.activecampaign.com/' },
  { label: 'Ad Hoc', url: 'https://www.adhocteam.us/' },
  { label: 'Adaface', url: 'https://www.adaface.com' },
  { label: 'AddStructure', url: 'https://www.bazaarvoice.com/' },
  { label: 'Adeva', url: 'https://adevait.com/' },
  { label: 'Adzuna', url: 'https://www.adzuna.co.uk/', remoteByDefault: true },
  { label: 'AE Studio', url: 'https://ae.studio/' },
  { label: 'Aerolab', url: 'https://aerolab.co/' },
  { label: 'Aerostrat', url: 'https://aerostratsoftware.com/' },
  { label: 'AgFlow', url: 'https://www.agflow.com' },
  { label: 'Aha!', url: 'https://www.aha.io', remoteByDefault: true },
  { label: 'Aim India', url: 'https://www.aimincorp.com/' },
  { label: 'Airbank', url: 'https://www.joinairbank.com/' },
  { label: 'Airbyte', url: 'https://airbyte.com/' },
  { label: 'AirGarage', url: 'https://www.airgarage.com/' },
  { label: 'AirTreks', url: 'https://www.airtreks.com/' },
  { label: 'Aivitex', url: 'https://aivitex.com/' },
  { label: 'Alami', url: 'https://alamisharia.co.id/en/' },
  { label: 'Alan', url: 'https://alan.com/' },
  { label: 'Algorand', url: 'https://www.algorand.com/' },
  { label: 'Algorithmia', url: 'https://algorithmia.com/' },
  { label: 'ALICE', url: 'https://aliceplatform.com', remoteByDefault: true },
  { label: 'Alight Solutions', url: 'https://alight.com', remoteByDefault: true },
  { label: 'Alley', url: 'https://alley.co' },
  { label: 'allyDVM', url: 'https://www.allydvm.com/' },
  { label: 'AlphaSights', url: 'https://engineering.alphasights.com' },
  { label: 'Amazon', url: 'https://www.amazon.jobs/en/locations/virtual-locations', remoteByDefault: true },
  { label: 'Ambaum', url: 'https://ambaum.com/' },
  { label: 'Andela', url: 'https://andela.com/', remoteByDefault: true },
  { label: 'Animalz', url: 'https://www.animalz.co' },
  { label: 'Annertech', url: 'https://www.annertech.com' },
  { label: 'Anomali', url: 'https://www.anomali.com/company/careers' },
  { label: 'apartment therapy', url: 'http://www.apartmenttherapy.com/' },
  { label: 'Appinio', url: 'https://appinio.com/' },
  { label: 'Applaudo', url: 'https://applaudostudios.com', remoteByDefault: true },
  { label: 'Appstractor Corporation', url: 'https://www.appstractor.com/' },
  { label: 'Appwrite', url: 'https://appwrite.io', remoteByDefault: true },
  { label: 'argyle', url: 'https://argyle.com/', remoteByDefault: true },
  { label: 'ARK', url: 'https://www.ark.io/careers', remoteByDefault: true },
  { label: 'Arkency', url: 'https://arkency.com/', remoteByDefault: true },
  { label: 'Art & Logic', url: 'https://artandlogic.com' },
  { label: 'Artefactual Systems', url: 'https://www.artefactual.com', remoteByDefault: true },
  { label: 'Articulate', url: 'https://www.articulate.com', remoteByDefault: true },
  { label: 'Astronomer', url: 'https://www.astronomer.io/' },
  { label: 'Atlassian', url: 'https://www.atlassian.com/' },
  { label: 'Audiense', url: 'https://www.audiense.com/', remoteByDefault: true },
  { label: 'Aula Education', url: 'https://aula.education/', remoteByDefault: true },
  { label: 'Auth0', url: 'https://auth0.com/', remoteByDefault: true },
  { label: 'Automattic', url: 'https://automattic.com/', remoteByDefault: true },
  { label: 'Axelerant', url: 'https://axelerant.com/', remoteByDefault: true },
  { label: 'Axios', url: 'https://axios.com/' },
  { label: 'Bairesdev', url: 'https://bairesdev.com/', remoteByDefault: true },
  { label: 'Balena', url: 'https://www.balena.io/', remoteByDefault: true },
  { label: 'Balsamiq', url: 'https://balsamiq.com/', remoteByDefault: true },
  { label: 'Bandcamp', url: 'https://bandcamp.com/', remoteByDefault: true },
  { label: 'BandLab', url: 'https://bandlab.com/', remoteByDefault: true },
  { label: 'Bandzoogle', url: 'https://bandzoogle.com/', remoteByDefault: true },
  { label: 'Baremetrics', url: 'https://baremetrics.com/', remoteByDefault: true },
  { label: 'Basecamp', url: 'https://basecamp.com/', remoteByDefault: true },
  { label: 'Bear Group', url: 'https://www.beargroup.com/' },
  { label: 'BeBanjo', url: 'https://bebanjo.com/', remoteByDefault: true },
  { label: 'BeenVerified', url: 'https://www.beenverified.com/', remoteByDefault: true },
  { label: 'Best Practical Solutions', url: 'https://bestpractical.com/', remoteByDefault: true },
  { label: 'Betable', url: 'https://corp.betable.com/' },
  { label: 'BetaPeak', url: 'https://betapeak.com/', remoteByDefault: true },
  { label: 'BetterUp', url: 'https://www.betterup.com/' },
  { label: 'Beyond Company', url: 'https://beyondcompany.com.br/' },
  { label: 'BeyondPricing', url: 'https://beyondpricing.com/' },
  { label: 'Big Cartel', url: 'https://www.bigcartel.com/', remoteByDefault: true },
  { label: 'Bill', url: 'https://bill.com/' },
  { label: 'Bit Zesty', url: 'https://bitzesty.com/', remoteByDefault: true },
  { label: 'Bitnami', url: 'https://bitnami.com/', remoteByDefault: true },
  { label: 'Bitovi', url: 'https://bitovi.com/', remoteByDefault: true },
  { label: 'Bizink', url: 'https://bizinkonline.com', remoteByDefault: true },
  { label: 'Blameless', url: 'https://www.blameless.com/' },
  { label: 'Bloc', url: 'https://bloc.io/' },
  { label: 'BlueCat Networks', url: 'https://bluecatnetworks.com/' },
  { label: 'Bluespark', url: 'https://www.bluespark.com/' },
  { label: 'Boldare', url: 'https://boldare.com', remoteByDefault: true },
  { label: 'Bonsai', url: 'https://www.hellobonsai.com', remoteByDefault: true },
  { label: 'Bounteous', url: 'https://bounteous.com', remoteByDefault: true },
  { label: 'Brainstorm Force', url: 'https://brainstormforce.com/', remoteByDefault: true },
  { label: 'Brave Investments', url: 'https://www.crunchbase.com/organization/brave-investment' },
  { label: 'Bright Funds', url: 'https://www.brightfunds.org' },
  { label: 'Brikl', url: 'https://www.brikl.com/' },
  { label: 'BriteCore', url: 'https://britecore.com/', remoteByDefault: true },
  { label: 'Broadwing', url: 'https://www.broadwing.io/', remoteByDefault: true },
  { label: 'Buffer', url: 'https://buffer.com', remoteByDefault: true },
  { label: 'Bugfender', url: 'https://bugfender.com/', remoteByDefault: true },
  { label: 'BuySellAds', url: 'https://www.buysellads.com/', remoteByDefault: true },
  { label: 'Cabify', url: 'https://cabify.com/' },
  { label: 'Calamari', url: 'https://calamari.io/' },
  { label: 'Calibre', url: 'https://calibreapp.com/', remoteByDefault: true },
  { label: 'CANCOM', url: 'https://www.cancom.com/' },
  { label: 'Canonical', url: 'https://www.canonical.com/', remoteByDefault: true },
  { label: 'Capchase', url: 'https://www.capchase.com/', remoteByDefault: true },
  { label: 'Capital One', url: 'https://www.capitalonecareers.com/tech' },
  { label: 'Carbon Black', url: 'https://www.carbonblack.com/' },
  { label: 'Cards Against Humanity', url: 'https://cardsagainsthumanity.com/' },
  { label: 'CareCru', url: 'https://carecru.com', remoteByDefault: true },
  { label: 'CareMessage', url: 'https://caremessage.org/careers/', remoteByDefault: true },
  { label: 'CartoDB', url: 'https://cartodb.com/', remoteByDefault: true },
  { label: 'CartStack', url: 'https://www.cartstack.com/', remoteByDefault: true },
  { label: 'Casumo', url: 'https://www.casumo.com/' },
  { label: 'Celsius', url: 'https://celsius.network/', remoteByDefault: true },
  { label: 'ChainLink Labs', url: 'https://chainlinklabs.com/' },
  { label: 'Chargify', url: 'https://www.chargify.com/' },
  { label: 'charity: water', url: 'https://www.charitywater.org/' },
  { label: 'ChatGen', url: 'https://chatgen.ai/' },
  { label: 'Checkly', url: 'https://www.checklyhq.com' },
  { label: 'Chef', url: 'https://www.chef.io/' },
  { label: 'ChefsClub', url: 'https://www.chefsclub.com.br/' },
  { label: 'Chess', url: 'https://www.chess.com/jobs/', remoteByDefault: true },
  { label: 'Chroma', url: 'https://hichroma.com/', remoteByDefault: true },
  { label: 'CircleCI', url: 'https://circleci.com/', remoteByDefault: true },
  { label: 'Circonus', url: 'https://circonus.com/' },
  { label: 'CivicActions', url: 'https://civicactions.com/', remoteByDefault: true },
  { label: 'Civo', url: 'https://www.civo.com', remoteByDefault: true },
  { label: 'Clevertech', url: 'https://clevertech.biz/', remoteByDefault: true },
  { label: 'ClickUp', url: 'https://clickup.com/', remoteByDefault: true },
  { label: 'Clootrack', url: 'https://www.clootrack.com/' },
  { label: 'Close', url: 'https://close.com', remoteByDefault: true },
  { label: 'CloudApp', url: 'https://getcloudapp.com' },
  { label: 'Coalition Technologies', url: 'https://coalitiontechnologies.com/', remoteByDefault: true },
  { label: 'Code Like a Girl', url: 'https://codelikeagirl.com' },
  { label: 'Codea IT', url: 'https://www.codeait.com', remoteByDefault: true },
  { label: 'CodePen', url: 'https://codepen.io', remoteByDefault: true },
  { label: 'CodeSandbox', url: 'https://codesandbox.io', remoteByDefault: true },
  { label: 'Codeship', url: 'https://codeship.com', remoteByDefault: true },
  { label: 'Codestunts', url: 'https://codestunts.com/', remoteByDefault: true },
  { label: 'Cofense', url: 'https://cofense.com' },
  { label: 'Coinbase', url: 'https://www.coinbase.com', remoteByDefault: true },
  { label: 'Coingape', url: 'https://coingape.com/' },
  { label: 'Collabora', url: 'https://www.collabora.com/', remoteByDefault: true },
  { label: 'Comet', url: 'https://www.comet.co/' },
  { label: 'Compose', url: 'https://www.compose.io/', remoteByDefault: true },
  { label: 'Compucorp', url: 'https://www.compucorp.co.uk', remoteByDefault: true },
  { label: 'Connexa', url: 'https://www.connexa.com/', remoteByDefault: true },
  { label: 'ConsenSys', url: 'https://consensys.net/', remoteByDefault: true },
  { label: 'Consumer Financial Protection Bureau', url: 'https://www.consumerfinance.gov' },
  { label: 'Continu', url: 'https://www.continu.co/' },
  { label: 'Conversio', url: 'https://conversio.com/', remoteByDefault: true },
  { label: 'Convert', url: 'https://www.convert.com', remoteByDefault: true },
  { label: 'Coodesh', url: 'https://coodesh.com/' },
  { label: 'Core-Apps', url: 'https://www.core-apps.com/' },
  { label: 'CoreOS', url: 'https://coreos.com/' },
  { label: 'Corgibytes', url: 'https://corgibytes.com' },
  { label: 'Coursera', url: 'https://www.coursera.org/' },
  { label: 'Crossover', url: 'https://www.crossover.com/', remoteByDefault: true },
  { label: 'Crowdstrike', url: 'https://www.crowdstrike.com', remoteByDefault: true },
  { label: 'CrowdTangle', url: 'https://crowdtangle.com/' },
  { label: 'Cueup', url: 'https://cueup.io/', remoteByDefault: true },
  { label: 'Customer.io', url: 'https://customer.io/', remoteByDefault: true },
  { label: 'Cuvette', url: 'https://cuvette.tech', remoteByDefault: true },
  { label: 'CVS Health', url: 'https://jobs.cvshealth.com' },
  { label: 'CWT', url: 'https://www.mycwt.com/', remoteByDefault: true },
  { label: 'Cyber Whale', url: 'https://cyberwhale.tech' },
  { label: 'Dalenys', url: 'https://dalenys.com/' },
  { label: 'DappRadar', url: 'https://dappradar.com/', remoteByDefault: true },
  { label: 'DareCode', url: 'https://darecode.com/' },
  { label: 'DashboardHub', url: 'https://dashboardhub.io', remoteByDefault: true },
  { label: 'Dashlane', url: 'https://dashlane.com', remoteByDefault: true },
  { label: 'Data Science Brigade', url: 'https://dsbrigade.com/', remoteByDefault: true },
  { label: 'Data Science Dojo', url: 'https://datasciencedojo.com/', remoteByDefault: true },
  { label: 'DataCamp', url: 'https://www.datacamp.com/' },
  { label: 'Datadog', url: 'https://www.datadoghq.com/', remoteByDefault: true },
  { label: 'DataStax', url: 'https://www.datastax.com/', remoteByDefault: true },
  { label: 'Datica', url: 'https://datica.com/' },
  { label: 'DealDash', url: 'http://www.dealdash.com', remoteByDefault: true },
  { label: 'Delighted', url: 'https://delighted.com', remoteByDefault: true },
  { label: 'Designcode', url: 'https://designcode.io/', remoteByDefault: true },
  { label: 'Deskpass', url: 'https://www.deskpass.com', remoteByDefault: true },
  { label: 'Dev Spotlight', url: 'https://www.devspotlight.com', remoteByDefault: true },
  { label: 'Devsquad', url: 'https://devsquad.com', remoteByDefault: true },
  { label: 'Dgraph', url: 'https://dgraph.io/' },
  { label: 'DigitalOcean', url: 'https://www.digitalocean.com/', remoteByDefault: true },
  { label: 'Digitise', url: 'https://jobs.gohire.io/digitise-xwcfqaab/', remoteByDefault: true },
  { label: 'Discord', url: 'https://discord.com/' },
  { label: 'Discourse', url: 'https://www.discourse.org/', remoteByDefault: true },
  { label: 'DNSimple', url: 'https://dnsimple.com/', remoteByDefault: true },
  { label: 'Docker', url: 'https://www.docker.com' },
  { label: 'Doist', url: 'https://doist.com', remoteByDefault: true },
  { label: 'Donut App', url: 'https://www.donut.app/' },
  { label: 'DroneDeploy', url: 'https://www.dronedeploy.com/', remoteByDefault: true },
  { label: 'Dropbox', url: 'https://www.dropbox.com/', remoteByDefault: true },
  { label: 'Drupal Jedi', url: 'https://drupaljedi.com/', remoteByDefault: true },
  { label: 'DuckDuckGo', url: 'https://duckduckgo.com/', remoteByDefault: true },
  { label: 'DynaPictures', url: 'https://dynapictures.com/', remoteByDefault: true },
  { label: 'EarthOfDrones', url: 'https://earthofdrones.com/', remoteByDefault: true },
  { label: 'EatStreet', url: 'https://eatstreet.com/' },
  { label: 'EBSCO Information Services', url: 'https://www.ebsco.com' },
  { label: 'Eco-Mind', url: 'https://eco-mind.eu/' },
  { label: 'Edgar', url: 'https://meetedgar.com/' },
  { label: 'Edgio', url: 'https://edg.io/', remoteByDefault: true },
  { label: 'Edify', url: 'https://edify.cr/', remoteByDefault: true },
  { label: 'eFishery', url: 'https://efishery.com/' },
  { label: 'Elastic', url: 'https://www.elastic.co/', remoteByDefault: true },
  { label: 'Emsisoft', url: 'https://www.emsisoft.com/', remoteByDefault: true },
  { label: 'EngineYard', url: 'https://www.engineyard.com/', remoteByDefault: true },
  { label: 'Enjoei', url: 'https://www.enjoei.com.br/' },
  { label: 'Enok', url: 'https://www.enok.co/' },
  { label: 'Entrision', url: 'https://entrision.com/' },
  { label: 'Envato', url: 'https://envato.com/', remoteByDefault: true },
  { label: 'Envoy', url: 'https://envoy.com/' },
  { label: 'Epam', url: 'https://epam.com/', remoteByDefault: true },
  { label: 'Epic Games', url: 'https://www.epicgames.com/site/en-US/careers', remoteByDefault: true },
  { label: 'Epilocal', url: 'https://www.epilocal.com/', remoteByDefault: true },
  { label: 'Episource', url: 'https://episource.com' },
  { label: 'Equal Experts Portugal', url: 'https://www.equalexperts.com/contact-us/lisbon/' },
  { label: 'Ergeon', url: 'https://www.ergeon.com/', remoteByDefault: true },
  { label: 'Estately', url: 'https://www.estately.com/' },
  { label: 'Etch', url: 'https://etch.co' },
  { label: 'Etsy', url: 'https://www.etsy.com/', remoteByDefault: true },
  { label: 'EVELO', url: 'https://evelo.com' },
  { label: 'Evil Martians', url: 'https://evilmartians.com/', remoteByDefault: true },
  { label: 'Evrone', url: 'https://evrone.com/', remoteByDefault: true },
  { label: 'ExportData', url: 'https://www.exportdata.io/', remoteByDefault: true },
  { label: 'Eyeo', url: 'https://eyeo.com/', remoteByDefault: true },
  { label: 'FactorialHR', url: 'https://www.factorialhr.com', remoteByDefault: true },
  { label: 'Fairwinds', url: 'https://www.fairwinds.com' },
  { label: 'Faithlife', url: 'https://www.faithlife.com/' },
  { label: 'Fastly', url: 'https://www.fastly.com/', remoteByDefault: true },
  { label: 'FATMAP', url: 'https://about.fatmap.com/careers' },
  { label: 'Fauna', url: 'https://www.fauna.com/', remoteByDefault: true },
  { label: 'Featurist', url: 'https://www.featurist.co.uk/', remoteByDefault: true },
  { label: 'Fetlife', url: 'https://fetlife.com/', remoteByDefault: true },
  { label: 'FFW Agency', url: 'https://ffwagency.com/' },
  { label: 'Filament Group', url: 'https://www.filamentgroup.com/' },
  { label: 'Findify', url: 'https://findify.io', remoteByDefault: true },
  { label: 'FingerprintJS', url: 'https://fingerprintjs.com', remoteByDefault: true },
  { label: 'Fire Engine Red', url: 'https://fire-engine-red.com/', remoteByDefault: true },
  { label: 'Fireball Labs', url: 'https://www.fireballlabs.com' },
  { label: 'Fiverr', url: 'https://www.fiverr.com/' },
  { label: 'FivexL', url: 'https://fivexl.io', remoteByDefault: true },
  { label: 'Flexera', url: 'https://www.flexera.com/' },
  { label: 'FlightAware', url: 'https://flightaware.com' },
  { label: 'Flip', url: 'https://flip.id' },
  { label: 'Flowing', url: 'https://flowing.it' },
  { label: 'Fly.io', url: 'https://fly.io', remoteByDefault: true },
  { label: 'FMX', url: 'https://www.gofmx.com/' },
  { label: 'Focusnetworks', url: 'https://focusnetworks.com.br', remoteByDefault: true },
  { label: 'fohandboh', url: 'https://fohandboh.com/', remoteByDefault: true },
  { label: 'Formidable', url: 'https://www.formidable.com/' },
  { label: 'Formstack', url: 'https://www.formstack.com/', remoteByDefault: true },
  { label: 'Four Kitchens', url: 'https://fourkitchens.com/' },
  { label: 'Fraudio', url: 'https://www.fraudio.com/' },
  { label: 'Freeagent', url: 'https://www.freeagent.com/', remoteByDefault: true },
  { label: 'Freeletics', url: 'https://www.freeletics.com/' },
  { label: 'Fuel Made', url: 'https://fuelmade.com/' },
  { label: 'FullFabric', url: 'https://fullfabric.com/' },
  { label: 'Functionize', url: 'https://www.functionize.com/', remoteByDefault: true },
  { label: 'Gaggle', url: 'https://www.gaggle.net/' },
  { label: 'Geckoboard', url: 'https://www.geckoboard.com' },
  { label: 'General Assembly', url: 'https://generalassemb.ly/', remoteByDefault: true },
  { label: 'GEO Jobe', url: 'https://www.geo-jobe.com/' },
  { label: 'Gerencianet', url: 'https://gerencianet.com.br' },
  { label: 'GFT', url: 'https://www.gft.com/' },
  { label: 'Ghost Foundation', url: 'https://ghost.org/', remoteByDefault: true },
  { label: 'Ghost Inspector', url: 'https://ghostinspector.com' },
  { label: 'Giant', url: 'https://giantmade.com' },
  { label: 'Giant Swarm', url: 'https://giantswarm.io' },
  { label: 'GigSalad', url: 'https://www.gigsalad.com/' },
  { label: 'Gitbook', url: 'https://www.gitbook.com/' },
  { label: 'GitHub', url: 'https://github.com/', remoteByDefault: true },
  { label: 'GitLab', url: 'https://about.gitlab.com/', remoteByDefault: true },
  { label: 'GitPrime', url: 'https://gitprime.com/', remoteByDefault: true },
  { label: 'Glenn Website Design', url: 'https://glennwebsitedesign.com/', remoteByDefault: true },
  { label: 'Glitch', url: 'https://www.glitch.com/', remoteByDefault: true },
  { label: 'Gluware', url: 'https://gluware.com/' },
  { label: 'GoDaddy', url: 'https://www.godaddy.com/', remoteByDefault: true },
  { label: 'GoHiring', url: 'https://www.gohiring.com/', remoteByDefault: true },
  { label: 'Gojob', url: 'https://gojob.com/' },
  { label: 'Gorman Health Group', url: 'https://conveyhealthsolutions.com/' },
  { label: 'GotSoccer', url: 'https://www.gotpro.com/' },
  { label: 'Grafana Labs', url: 'https://grafana.com/' },
  { label: 'Granicus', url: 'https://granicus.com/' },
  { label: 'Graylog', url: 'https://graylog.org/', remoteByDefault: true },
  { label: 'Gremlin', url: 'https://gremlin.com' },
  { label: 'Gridium', url: 'https://gridium.com' },
  { label: 'Groove', url: 'https://www.groovehq.com', remoteByDefault: true },
  { label: 'Grou.ps', url: 'https://build.gr.ps', remoteByDefault: true },
  { label: 'Grubhub', url: 'https://www.grubhub.com/', remoteByDefault: true },
  { label: 'Gruntwork', url: 'https://gruntwork.io/', remoteByDefault: true },
  { label: 'GuideSmiths', url: 'https://www.guidesmiths.com/' },
  { label: 'Hack Reactor Remote', url: 'https://www.hackreactor.com/remote/' },
  { label: 'Hanno', url: 'https://hanno.co', remoteByDefault: true },
  { label: 'Hanzo', url: 'https://hanzo.co' },
  { label: 'Happy Cog', url: 'https://happycog.com/' },
  { label: 'Harvest', url: 'https://www.getharvest.com/', remoteByDefault: true },
  { label: 'Hashex', url: 'https://hashex.org/' },
  { label: 'HashiCorp', url: 'https://www.hashicorp.com/' },
  { label: 'HE:labs', url: 'https://www.helabs.com', remoteByDefault: true },
  { label: 'Headway', url: 'https://www.headway.io/' },
  { label: 'Healthfinch', url: 'https://www.healthfinch.com/' },
  { label: 'Heap', url: 'https://heapanalytics.com/', remoteByDefault: true },
  { label: 'Heetch', url: 'https://heetch.com/' },
  { label: 'Help Scout', url: 'https://www.helpscout.net/', remoteByDefault: true },
  { label: 'Heroku', url: 'https://www.heroku.com/' },
  { label: 'Hireology', url: 'https://www.hireology.com' },
  { label: 'HomeFlicWeGrow', url: 'https://www.homeflicwegrow.com/' },
  { label: 'HomeValet', url: 'https://homevalet.co' },
  { label: 'Honeybadger', url: 'https://www.honeybadger.io/', remoteByDefault: true },
  { label: 'Honeycomb', url: 'https://honeycomb.tv/', remoteByDefault: true },
  { label: 'Hopper', url: 'https://www.hopper.com/' },
  { label: 'Hotjar', url: 'https://careers.hotjar.com/', remoteByDefault: true },
  { label: 'Hudl', url: 'https://www.hudl.com/' },
  { label: 'Hugo', url: 'https://hugo.events', remoteByDefault: true },
  { label: 'Human Made', url: 'https://hmn.md', remoteByDefault: true },
  { label: 'HUSL Digital', url: 'https://husldigital.com' },
  { label: 'Hypergiant', url: 'https://www.hypergiant.com/contact/', remoteByDefault: true },
  { label: 'Hyperion', url: 'https://hyperiondev.com/jobs' },
  { label: 'Hypothesis', url: 'https://hypothes.is', remoteByDefault: true },
  { label: 'IBM', url: 'https://www.ibm.com', remoteByDefault: true },
  { label: 'iClinic', url: 'https://iclinic.com.br/' },
  { label: 'IDoneThis', url: 'https://idonethis.com/', remoteByDefault: true },
  { label: 'iFit', url: 'https://www.ifit.com/' },
  { label: 'Igalia', url: 'https://www.igalia.com/' },
  { label: 'Imagine Learning', url: 'https://www.imaginelearning.com' },
  { label: 'Impala', url: 'https://www.getimpala.com/' },
  { label: 'Impira', url: 'https://www.impira.com/' },
  { label: 'Implisense', url: 'https://implisense.com/' },
  { label: 'InVision', url: 'https://www.invisionapp.com/', remoteByDefault: true },
  { label: 'IOHK', url: 'https://iohk.io/', remoteByDefault: true },
  { label: 'IOpipe', url: 'https://iopipe.com' },
  { label: 'iOS App Templates', url: 'https://www.iosapptemplates.com/', remoteByDefault: true },
  { label: 'IPinfo', url: 'https://ipinfo.io/', remoteByDefault: true },
  { label: 'IPS Group, Inc.', url: 'https://www.ipsgroupinc.com/' },
  { label: 'IQVIA', url: 'https://jobs.iqvia.com/our-company', remoteByDefault: true },
  { label: 'iRonin', url: 'https://www.ironin.it/', remoteByDefault: true },
  { label: 'Iterative', url: 'https://www.iterative.ai/', remoteByDefault: true },
  { label: 'iwantmyname', url: 'https://iwantmyname.com/', remoteByDefault: true },
  { label: 'Jackson River', url: 'https://jacksonriver.com/' },
  { label: 'Jaya Tech', url: 'https://jaya.tech/', remoteByDefault: true },
  { label: 'JBS Custom Software Solutions', url: 'https://www.jbssolutions.com/' },
  { label: 'Jitbit', url: 'https://www.jitbit.com/', remoteByDefault: true },
  { label: 'Jitera', url: 'https://iruuza-inc.com/', remoteByDefault: true },
  { label: 'Jobsity', url: 'https://recruitment.jobsity.com/' },
  { label: 'Jolly Good Code', url: 'https://www.jollygoodcode.com', remoteByDefault: true },
  { label: 'journy.io', url: 'https://www.journy.io' },
  { label: 'Joyent', url: 'https://www.joyent.com/careers/' },
  { label: 'JupiterOne', url: 'https://www.jupiterone.com/careers/' },
  { label: 'Kaggle', url: 'https://kaggle.com/', remoteByDefault: true },
  { label: 'kea', url: 'https://kea.ai' },
  { label: 'Kentik', url: 'https://www.kentik.com/careers' },
  { label: 'Khan Academy', url: 'https://www.khanacademy.org/' },
  { label: 'KickBack Rewards Systems', url: 'https://careers.kickbacksystems.com' },
  { label: 'Kinsta', url: 'https://kinsta.com/', remoteByDefault: true },
  { label: 'Kiprosh', url: 'https://kiprosh.com/' },
  { label: 'Kissmetrics', url: 'https://www.kissmetrics.com/', remoteByDefault: true },
  { label: 'Klaviyo', url: 'https://www.klaviyo.com/' },
  { label: 'Knack', url: 'https://www.knack.com' },
  { label: 'Kodify', url: 'https://kodify.io', remoteByDefault: true },
  { label: 'Koding', url: 'https://koding.com', remoteByDefault: true },
  { label: 'Komoot', url: 'https://www.komoot.com', remoteByDefault: true },
  { label: 'Kona', url: 'https://www.heykona.com', remoteByDefault: true },
  { label: 'Konkurenta', url: 'https://konkurenta.com' },
  { label: 'Kraken', url: 'https://kraken.com', remoteByDefault: true },
  { label: 'Kuali', url: 'https://kuali.co' },
  { label: 'Labelbox', url: 'https://labelbox.com/', remoteByDefault: true },
  { label: 'Lambda School', url: 'https://www.lambdaschool.com/' },
  { label: 'Lambert Labs', url: 'https://lambertlabs.com/' },
  { label: 'LaterPay', url: 'https://www.laterpay.net/', remoteByDefault: true },
  { label: 'Leadership Success', url: 'https://www.leadershipsuccess.co/', remoteByDefault: true },
  { label: 'Leadfeeder', url: 'https://www.leadfeeder.com' },
  { label: 'LeadIQ', url: 'https://leadiq.com/', remoteByDefault: true },
  { label: 'Let\'s Encrypt', url: 'https://letsencrypt.org' },
  { label: 'Lifen', url: 'https://www.lifen.health/' },
  { label: 'Lifetime Value Company', url: 'https://www.ltvco.com/', remoteByDefault: true },
  { label: 'Lightbend', url: 'https://www.lightbend.com/', remoteByDefault: true },
  { label: 'Lightspeed', url: 'https://www.lightspeedhq.com/', remoteByDefault: true },
  { label: 'Linaro', url: 'https://www.linaro.org/', remoteByDefault: true },
  { label: 'Lincoln Loop', url: 'https://lincolnloop.com/' },
  { label: 'LINE Plus Corporation', url: 'https://lineplus.com/' },
  { label: 'Link11', url: 'https://www.link11.com/' },
  { label: 'Linux Foundation', url: 'https://www.linuxfoundation.org/', remoteByDefault: true },
  { label: 'LionSher', url: 'https://lionsher.com/careers/', remoteByDefault: true },
  { label: 'Litmus', url: 'https://litmus.com/', remoteByDefault: true },
  { label: 'LivePerson', url: 'https://www.liveperson.com/company/careers', remoteByDefault: true },
  { label: 'Loadsys Web Strategies', url: 'https://www.loadsys.com' },
  { label: 'Localistico', url: 'https://localistico.com/', remoteByDefault: true },
  { label: 'LogDNA', url: 'https://logdna.com', remoteByDefault: true },
  { label: 'Lullabot', url: 'https://www.lullabot.com/', remoteByDefault: true },
  { label: 'Luxoft', url: 'https://www.luxoft.com/', remoteByDefault: true },
  { label: 'Lyseon Tech', url: 'https://lt.coop.br/' },
  { label: 'Lytx', url: 'https://www.lytx.com/en-us/about-us/careers' },
  { label: 'madewithlove', url: 'https://madewithlove.com', remoteByDefault: true },
  { label: 'Madisoft', url: 'https://labs.madisoft.it/' },
  { label: 'MailerLite', url: 'https://www.mailerlite.com', remoteByDefault: true },
  { label: 'Manifold', url: 'https://manifold.co', remoteByDefault: true },
  { label: 'Mapbox', url: 'https://www.mapbox.com/', remoteByDefault: true },
  { label: 'Marco Polo Inc.', url: 'https://marcopolo.me' },
  { label: 'Marketade', url: 'https://www.marketade.com' },
  { label: 'MeridianLink', url: 'https://meridianlink.com/' },
  { label: 'MetaLab', url: 'https://metalab.co', remoteByDefault: true },
  { label: 'MetaMask', url: 'https://metamask.io', remoteByDefault: true },
  { label: 'MeteorOps', url: 'https://meteorops.com', remoteByDefault: true },
  { label: 'Microsoft', url: 'https://www.microsoft.com', remoteByDefault: true },
  { label: 'Mindful', url: 'https://getmindful.com/', remoteByDefault: true },
  { label: 'Mixcloud', url: 'https://www.mixcloud.com/' },
  { label: 'Mixmax', url: 'https://mixmax.com', remoteByDefault: true },
  { label: 'MixRank', url: 'https://mixrank.com', remoteByDefault: true },
  { label: 'Mobile Jazz', url: 'https://mobilejazz.com', remoteByDefault: true },
  { label: 'Modern Health', url: 'https://www.modernhealth.com/' },
  { label: 'Modern Tribe', url: 'https://tri.be/', remoteByDefault: true },
  { label: 'Modsquad', url: 'https://modsquad.com/', remoteByDefault: true },
  { label: 'Molteo', url: 'https://molteo.com/', remoteByDefault: true },
  { label: 'MongoDB', url: 'https://mongodb.com', remoteByDefault: true },
  { label: 'Monthly', url: 'https://monthly.com' },
  { label: 'Mozilla', url: 'https://www.mozilla.org/' },
  { label: 'mtc.', url: 'https://www.mtcmedia.co.uk' },
  { label: 'Muck Rack', url: 'https://muckrack.com', remoteByDefault: true },
  { label: 'Mux', url: 'https://mux.com', remoteByDefault: true },
  { label: 'Mycelium', url: 'https://mycelium.ventures/' },
  { label: 'MySQL', url: 'https://www.mysql.com/', remoteByDefault: true },
  { label: 'Nagarro', url: 'https://www.nagarro.com/en', remoteByDefault: true },
  { label: 'Nationwide', url: 'https://www.nationwide.com/' },
  { label: 'NetApp', url: 'https://www.netapp.com/', remoteByDefault: true },
  { label: 'Netguru', url: 'https://www.netguru.com', remoteByDefault: true },
  { label: 'Netris', url: 'https://www.netris.ai', remoteByDefault: true },
  { label: 'Netsparker', url: 'https://www.netsparker.com/', remoteByDefault: true },
  { label: 'Nettl Edinburgh', url: 'https://www.webdesignedinburgh.com' },
  { label: 'New Context', url: 'https://www.newcontext.com' },
  { label: 'NEXT', url: 'https://www.nexttrucking.com' },
  { label: 'No Code No Problem', url: 'https://www.nocodenoprob.com', remoteByDefault: true },
  { label: 'NodeSource', url: 'https://nodesource.com', remoteByDefault: true },
  { label: 'NoRedInk', url: 'https://noredink.com', remoteByDefault: true },
  { label: 'Novoda', url: 'https://www.novoda.com/' },
  { label: 'npm', url: 'https://www.npmjs.com/' },
  { label: 'Nuage', url: 'https://nuagebiz.tech/' },
  { label: 'Nuna', url: 'https://www.nuna.com/' },
  { label: 'Nvidia', url: 'https://www.nvidia.com/', remoteByDefault: true },
  { label: 'O\'Reilly Media', url: 'https://www.oreilly.com/' },
  { label: 'Ocient', url: 'https://ocient.com' },
  { label: 'Octopus Deploy', url: 'https://octopus.com', remoteByDefault: true },
  { label: 'Oddball', url: 'https://oddball.io/' },
  { label: 'Okta', url: 'https://www.okta.com', remoteByDefault: true },
  { label: 'Olark', url: 'https://www.olark.com/', remoteByDefault: true },
  { label: 'Olist', url: 'https://olist.com/' },
  { label: 'Ollie', url: 'https://www.myollie.com' },
  { label: 'Ollie Order', url: 'https://ollieorder.com/' },
  { label: 'Olo', url: 'https://www.olo.com/' },
  { label: 'OmbuLabs', url: 'https://www.ombulabs.com/', remoteByDefault: true },
  { label: 'OmniTI', url: 'https://omniti.com/' },
  { label: 'Onna', url: 'https://onna.com/' },
  { label: 'OnTheGoSystems', url: 'https://onthegosystems.com', remoteByDefault: true },
  { label: 'Opencity Labs', url: 'https://opencitylabs.it/' },
  { label: 'OpenCraft', url: 'https://opencraft.com/', remoteByDefault: true },
  { label: 'OpenZeppelin', url: 'https://openzeppelin.com/', remoteByDefault: true },
  { label: 'Optoro', url: 'https://www.optoro.com/', remoteByDefault: true },
  { label: 'Oracle', url: 'https://www.oracle.com/', remoteByDefault: true },
  { label: 'Ordermentum', url: 'https://www.ordermentum.com/' },
  { label: 'Our-Hometown Inc.', url: 'https://our-hometown.com/' },
  { label: 'OutsourcingDev', url: 'https://www.outsourcingdev.com/', remoteByDefault: true },
  { label: 'Over', url: 'https://www.madewithover.com/', remoteByDefault: true },
  { label: 'Packlink', url: 'https://www.packlink.com/', remoteByDefault: true },
  { label: 'Pagepro', url: 'https://pagepro.co' },
  { label: 'PagerDuty', url: 'https://pagerduty.com' },
  { label: 'Paktor', url: 'https://www.gopaktor.com/', remoteByDefault: true },
  { label: 'Palantir.net', url: 'https://www.palantir.net/' },
  { label: 'Panther Labs', url: 'https://runpanther.io/' },
  { label: 'Parabol', url: 'https://www.parabol.co/', remoteByDefault: true },
  { label: 'Park Assist', url: 'https://tech.parkassist.com', remoteByDefault: true },
  { label: 'Parsely', url: 'https://www.parse.ly/', remoteByDefault: true },
  { label: 'Particular Software', url: 'https://particular.net', remoteByDefault: true },
  { label: 'Pathable', url: 'https://pathable.com/', remoteByDefault: true },
  { label: 'Payfully', url: 'https://www.payfully.co', remoteByDefault: true },
  { label: 'Paylocity', url: 'https://www.paylocity.com/' },
  { label: 'Payscale', url: 'https://www.payscale.com/' },
  { label: 'Paytm Labs', url: 'https://paytmlabs.com/' },
  { label: 'PayU', url: 'https://corporate.payu.com', remoteByDefault: true },
  { label: 'Peachworks', url: 'https://www.getbeyond.com/peachworks-restaurant-management-software/' },
  { label: 'PeopleDoc', url: 'https://www.people-doc.com' },
  { label: 'Percona', url: 'https://www.percona.com', remoteByDefault: true },
  { label: 'Pex', url: 'https://pex.com', remoteByDefault: true },
  { label: 'Plai', url: 'https://plai.team' },
  { label: 'Platform Builders', url: 'https://platformbuilders.io/', remoteByDefault: true },
  { label: 'Platform.sh', url: 'https://platform.sh/', remoteByDefault: true },
  { label: 'Pleo', url: 'https://www.pleo.io/', remoteByDefault: true },
  { label: 'Plex', url: 'https://plex.tv', remoteByDefault: true },
  { label: 'PNC Financial Services', url: 'https://www.pnc.com/' },
  { label: 'Polygon', url: 'https://polygon.technology/careers/', remoteByDefault: true },
  { label: 'PowerSchool', url: 'https://www.powerschool.com/' },
  { label: 'Pragma', url: 'https://www.pragma.co/' },
  { label: 'Precision Nutrition', url: 'https://www.precisionnutrition.com/', remoteByDefault: true },
  { label: 'Predict Mobile', url: 'https://predictmobile.com/' },
  { label: 'Prelude', url: 'https://www.prelude.co/' },
  { label: 'PreviousNext', url: 'https://www.previousnext.com.au/' },
  { label: 'Prezi', url: 'https://prezi.com/jobs/' },
  { label: 'Prezly', url: 'https://www.prezly.com/', remoteByDefault: true },
  { label: 'PricewaterhouseCoopers', url: 'https://www.pwc.com' },
  { label: 'Primer', url: 'https://primer.io/careers', remoteByDefault: true },
  { label: 'Prisma', url: 'https://www.prisma.io/', remoteByDefault: true },
  { label: 'PrivacyCloud', url: 'https://www.privacycloud.com/en' },
  { label: 'Procenge Tecnologia', url: 'https://www.procenge.com.br' },
  { label: 'Procurify', url: 'https://procurify.com/careers' },
  { label: 'Progress Engine', url: 'https://www.progress-engine.com/en', remoteByDefault: true },
  { label: 'Prominent Edge', url: 'https://prominentedge.com/careers', remoteByDefault: true },
  { label: 'Puppet', url: 'https://puppet.com/', remoteByDefault: true },
  { label: 'Quaderno', url: 'https://quaderno.io/' },
  { label: 'Quantify', url: 'https://quantifyhq.com', remoteByDefault: true },
  { label: 'QuestDB', url: 'https://questdb.io', remoteByDefault: true },
  { label: 'Quora', url: 'https://www.quora.com', remoteByDefault: true },
  { label: 'Rackspace', url: 'https://rackspace.com', remoteByDefault: true },
  { label: 'Raft', url: 'https://goraft.tech' },
  { label: 'Rainforest QA', url: 'https://www.rainforestqa.com/jobs/', remoteByDefault: true },
  { label: 'Rakuten Travel Xchange', url: 'https://solutions.travel.rakuten.com', remoteByDefault: true },
  { label: 'Ramp', url: 'https://www.ramp.com/', remoteByDefault: true },
  { label: 'Reaction Commerce', url: 'https://reactioncommerce.com/careers/', remoteByDefault: true },
  { label: 'ReactiveOps, Inc.', url: 'https://www.reactiveops.com' },
  { label: 'real.digital', url: 'https://www.real-digital.de' },
  { label: 'RealtimeCRM', url: 'https://realtimecrm.co.uk/', remoteByDefault: true },
  { label: 'RebelMouse', url: 'https://www.rebelmouse.com/', remoteByDefault: true },
  { label: 'Reboot Studio', url: 'https://www.reboot.studio/', remoteByDefault: true },
  { label: 'ReCharge', url: 'https://rechargepayments.com/', remoteByDefault: true },
  { label: 'Recurly', url: 'https://recurly.com/' },
  { label: 'Red Hat', url: 'https://www.redhat.com', remoteByDefault: true },
  { label: 'Reddit', url: 'https://redditinc.com' },
  { label: 'RedMonk', url: 'https://redmonk.com', remoteByDefault: true },
  { label: 'Redox', url: 'https://www.redoxengine.com/' },
  { label: 'Reducer', url: 'https://reducer.co.uk' },
  { label: 'reinteractive', url: 'https://reinteractive.com/careers', remoteByDefault: true },
  { label: 'Remote Garage', url: 'http://www.remotegarage.club/' },
  { label: 'RemoteBase', url: 'https://remotebase.com', remoteByDefault: true },
  { label: 'RenoFi', url: 'https://renofi.com/', remoteByDefault: true },
  { label: 'Replit', url: 'https://replit.com', remoteByDefault: true },
  { label: 'Research Square', url: 'https://www.researchsquare.com/' },
  { label: 'Revolut', url: 'https://www.revolut.com/', remoteByDefault: true },
  { label: 'Roadtrippers', url: 'https://www.roadtrippers.com' },
  { label: 'Rocket.Chat', url: 'https://rocket.chat', remoteByDefault: true },
  { label: 'rtCamp', url: 'https://rtcamp.com', remoteByDefault: true },
  { label: 'Safeguard Global', url: 'https://www.safeguardglobal.com/', remoteByDefault: true },
  { label: 'Salesforce', url: 'https://www.salesforce.com/', remoteByDefault: true },
]

function validDate(value: unknown): string {
  const time = Date.parse(String(value || ''))
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString()
}

function locationFromPosting(posting: any): string {
  const raw = Array.isArray(posting?.jobLocation)
    ? posting.jobLocation
    : posting?.jobLocation
      ? [posting.jobLocation]
      : []

  const values = raw
    .map((item: any) => item?.address || item)
    .map((address: any) => [
      address?.addressLocality,
      address?.addressRegion,
      address?.addressCountry?.name || address?.addressCountry,
    ].filter(Boolean).join(', '))
    .filter(Boolean)

  if (values.length) return [...new Set(values)].join('; ')
  if (posting?.jobLocationType === 'TELECOMMUTE') return 'Remote'
  return 'See listing'
}

function boardTags(board: PublicBoard): string[] {
  const tags = [board.label]
  if (board.sponsorshipConfidence === 'explicit') tags.push('Visa sponsorship', 'Explicit sponsorship')
  if (board.sponsorshipConfidence === 'verified') tags.push('Visa sponsorship', 'Verified sponsor')
  if (board.sponsorshipConfidence === 'historical') tags.push('H1B sponsor history')
  if (board.usOnly) tags.push('USA')
  return tags
}

function sponsorshipFields(board: PublicBoard): Pick<Job, 'sponsorshipConfidence' | 'sponsorshipEvidence'> {
  return {
    ...(board.sponsorshipConfidence ? { sponsorshipConfidence: board.sponsorshipConfidence } : {}),
    ...(board.sponsorshipEvidence ? { sponsorshipEvidence: [board.sponsorshipEvidence] } : {}),
  }
}

function jsonLdNodes(value: any): any[] {
  if (!value) return []
  if (Array.isArray(value)) return value.flatMap(jsonLdNodes)
  const graph = value?.['@graph']
  return graph ? jsonLdNodes(graph) : [value]
}

function parseJsonLd(html: string, board: PublicBoard): Job[] {
  const out: Job[] = []
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null

  while ((match = re.exec(html))) {
    let parsed: any
    try {
      parsed = JSON.parse(match[1]!)
    } catch {
      continue
    }

    for (const node of jsonLdNodes(parsed)) {
      const type = node?.['@type']
      const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))
      if (!isJob || !node?.title) continue

      const url = absoluteUrl(String(node.url || node.sameAs || ''), board.url)
      if (!url) continue
      const location = locationFromPosting(node)
      if (board.usOnly && !board.assumeUs && !detectUsLocation(location)) continue
      const company = stripHtml(node?.hiringOrganization?.name) || board.label
      const description = stripHtml(node.description)

      out.push({
        id: `public-${board.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${url}`,
        title: stripHtml(node.title),
        company,
        location: board.assumeUs && location === 'See listing' ? 'United States' : location,
        url,
        source: 'companies',
        remote: board.remoteByDefault === true
          || node.jobLocationType === 'TELECOMMUTE'
          || /remote|anywhere|worldwide/i.test(`${node.title} ${location} ${description}`),
        tags: boardTags(board),
        postedAt: validDate(node.datePosted),
        employmentType: Array.isArray(node.employmentType) ? node.employmentType[0] : node.employmentType,
        description: description.slice(0, 4000) || undefined,
        ...sponsorshipFields(board),
      })
    }
  }

  return out
}

function looksLikeJobUrl(url: URL): boolean {
  const path = url.pathname.toLowerCase().replace(/\/+$/, '')
  if (!path || path === '/') return false

  if (/\/(?:login|signin|signup|register|pricing|employers?|companies|categories|search)(?:\/|$)/.test(path)) {
    return false
  }

  return /\/(?:jobs?|job|vacanc(?:y|ies)|positions?|openings?|opportunities)\/[a-z0-9][^/]{2,}/i.test(path)
    || /\/job[-_][a-z0-9][a-z0-9_-]{4,}/i.test(path)
}

function parseAnchors(html: string, board: PublicBoard): Job[] {
  if (board.usOnly && !board.assumeUs) return []

  const byUrl = new Map<string, string>()
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null

  while ((match = re.exec(html))) {
    const href = absoluteUrl(match[1]!, board.url)
    if (!href) continue

    let parsed: URL
    try {
      parsed = new URL(href)
    } catch {
      continue
    }
    if (!looksLikeJobUrl(parsed)) continue

    const title = stripHtml(match[2])
    if (title.length < 3 || title.length > 180) continue
    if (/^(apply|view|details?|read more|learn more|save|next|previous)$/i.test(title)) continue

    const existing = byUrl.get(href)
    if (!existing || title.length < existing.length) byUrl.set(href, title)
  }

  const now = new Date().toISOString()
  return [...byUrl.entries()].map(([url, title]) => ({
    id: `public-${board.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${url}`,
    title,
    company: board.label,
    location: board.assumeUs ? 'United States' : board.remoteByDefault ? 'Remote' : 'See listing',
    url,
    source: 'companies',
    remote: board.remoteByDefault === true || /remote|anywhere|worldwide/i.test(title),
    tags: boardTags(board),
    postedAt: now,
    ...sponsorshipFields(board),
  }))
}

export function parsePublicBoardPage(html: string, board: PublicBoard): Job[] {
  const byUrl = new Map<string, Job>()
  for (const job of [...parseJsonLd(html, board), ...parseAnchors(html, board)]) byUrl.set(job.url, job)
  return [...byUrl.values()]
}
