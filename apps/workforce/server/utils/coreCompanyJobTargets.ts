import {
  crawlStandardJobBoard,
  enrichStandardJobBoardDetails,
} from './cyclicJobBoardCrawler'
import { extractSalaryFromText } from '../vacancies/domain/enrich'
import type { Job } from '~~/shared/contracts/jobs'

const API_UA = 'jobFinder/1.0 (job aggregator; contact: admin@whiteslove.me)'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const DESC_MAX = Number.POSITIVE_INFINITY

const DEFAULT_GREENHOUSE = [
  'airbnb:Airbnb', 'adyen:Adyen', 'anthropic:Anthropic', 'asana:Asana', 'block:Block',
  'brex:Brex', 'canonical:Canonical', 'cloudflare:Cloudflare', 'coinbase:Coinbase',
  'coupang:Coupang', 'datadog:Datadog', 'deepmind:DeepMind', 'discord:Discord',
  'dropbox:Dropbox', 'elastic:Elastic', 'fastly:Fastly', 'figma:Figma', 'fxpro:FxPro',
  'gitlab:GitLab', 'grafanalabs:Grafana Labs', 'gusto:Gusto', 'hellofresh:HelloFresh',
  'instacart:Instacart', 'jetbrains:JetBrains', 'lucidmotors:Lucid Motors', 'lyft:Lyft',
  'mongodb:MongoDB', 'monzo:Monzo', 'netlify:Netlify', 'newrelic:New Relic', 'reddit:Reddit',
  'roblox:Roblox', 'scaleai:Scale AI', 'skyscanner:Skyscanner', 'smartsheet:Smartsheet',
  'tripadvisor:Tripadvisor', 'twilio:Twilio', 'twitch:Twitch', 'zscaler:Zscaler',
  'stockx:StockX', 'getyourguide:GetYourGuide', 'careem:Careem', 'shein:SHEIN',
  'wallapop:Wallapop', 'mirakl:Mirakl', 'cabify:Cabify', 'bird:Bird', 'n26:N26',
  'trustpilot:Trustpilot', 'sumup:SumUp',
  'databricks:Databricks', 'stripe:Stripe', 'pinterest:Pinterest', 'robinhood:Robinhood',
  'samsara:Samsara', 'verkada:Verkada', 'wolt:Wolt', 'braze:Braze', 'celonis:Celonis',
  'affirm:Affirm', 'klaviyo:Klaviyo', 'doctolib:Doctolib', 'flexport:Flexport',
  'gongio:Gong', 'faire:Faire', 'chime:Chime', 'sofi:SoFi', 'vercel:Vercel',
  'temporaltechnologies:Temporal', 'bitpanda:Bitpanda', 'attentive:Attentive',
  'amplitude:Amplitude', 'mixpanel:Mixpanel', 'airtable:Airtable', 'betterment:Betterment',
  'raisin:Raisin', 'gocardless:GoCardless', 'dataiku:Dataiku', 'contentful:Contentful',
  'cockroachlabs:Cockroach Labs', 'gemini:Gemini', 'iterable:Iterable', 'squarespace:Squarespace',
  'yotpo:Yotpo', 'calendly:Calendly', 'labelbox:Labelbox', 'truelayer:TrueLayer',
  'planetscale:PlanetScale', 'consensys:ConsenSys',
  'riotgames:Riot Games', 'epicgames:Epic Games', 'rockstargames:Rockstar Games',
  'taketwo:Take-Two', 'krafton:KRAFTON', 'scopely:Scopely', 'peak:Peak Games',
  'wildlifestudios:Wildlife Studios', 'wooga:Wooga',
  'nix:N-iX', 'mhp:MHP', 'baidu:Baidu',
].join(',')

const DEFAULT_LEVER = [
  'ajax:Ajax Systems', 'easybrain:Easybrain', 'trendyol:Trendyol',
  'vestiairecollective:Vestiaire Collective', 'qonto:Qonto',
  'palantir:Palantir', 'spotify:Spotify', 'toptal:Toptal',
  'matchgroup:Match Group', 'dreamgames:Dream Games', 'jamcity:Jam City',
  'eleks:ELEKS', 'intellias:Intellias',
].join(',')

const DEFAULT_SMARTRECRUITERS = [
  'DeliveryHero:Delivery Hero', 'Wise:Wise', 'Canva:Canva', 'ASOS:ASOS',
  'ByteDance:ByteDance', 'Joom:Joom', 'Uber:Uber', 'Wayfair:Wayfair',
  'Grab:Grab', 'BigCommerce:BigCommerce', 'Omio:Omio', 'Gameloft:Gameloft',
  'Alorica:Alorica', 'geico:GEICO',
].join(',')

const DEFAULT_ASHBY = [
  'openai:OpenAI', 'harvey:Harvey', 'elevenlabs:ElevenLabs', 'sierra:Sierra',
  'notion:Notion', 'cohere:Cohere', 'ramp:Ramp', 'decagon:Decagon', 'vanta:Vanta',
  'cursor:Cursor', 'replit:Replit', 'perplexity:Perplexity', 'synthesia:Synthesia',
  'baseten:Baseten', 'mercor:Mercor', 'writer:Writer', 'benchling:Benchling',
  'supabase:Supabase', 'watershed:Watershed', 'sardine:Sardine', 'modal:Modal',
  'rho:Rho', 'linear:Linear', 'posthog:PostHog', 'railway:Railway', 'runway:Runway',
  'voodoo:Voodoo', 'supercell:Supercell', 'preply:Preply', 'headway:Headway',
  'solidgate:Solidgate', 'obrio:OBRIO', 'universe:Universe', 'restream:Restream',
  'zapier:Zapier', 'buffer:Buffer',
].join(',')

const DEFAULT_CAREERS_PAGES = [
  'DHL|https://careers.dhl.com/global/en',
  'Mastercard|https://careers.mastercard.com/us/en',
  'Allianz|https://careers.allianz.com/global/en',
  'BCG|https://careers.bcg.com/global/en',
  'Air Canada|https://careers.aircanada.com/ca/en',
  'Alight|https://careers.alight.com/us/en',
  'Fiserv|https://careers.fiserv.com/us/en',
  'FIS|https://careers.fisglobal.com/us/en',
  'Robert Half|https://careers.roberthalf.com/global/en',
  'Southwest Airlines|https://careers.southwestair.com/us/en',
  'Thales|https://careers.thalesgroup.com/global/en',
  'United Airlines|https://careers.united.com/us/en',
  'eBay|https://jobs.ebayinc.com/us/en',
  'Air Arabia|https://www.airarabiagroupcareers.com/gb/en',
  'RTX|https://careers.rtx.com/global/en',
  'Humana|https://careers.humana.com/',
  'CVS Health|https://jobs.cvshealth.com/us/en',
  'Cigna|https://jobs.thecignagroup.com/us/en',
  'Unilever|https://careers.unilever.com/en',
  'Nike|https://careers.nike.com/',
  'Expedia Group|https://careers.expediagroup.com/',
  'Home Depot|https://careers.homedepot.com/',
  'Linklaters|https://www.linklaters.com/careers',
  'Elevance Health|https://careers.elevancehealth.com/',
  'Voi|https://careers.voi.com/',
  'Moove|https://careers.moove.io/',
  'Savills|https://careers.savills.com/',
  'Cisco|https://careers.cisco.com/',
  'Adobe|https://careers.adobe.com/',
  'Red Hat|https://careers.redhat.com/',
  'Autodesk|https://careers.autodesk.com/',
  'Snowflake|https://careers.snowflake.com/',
  'Sophos|https://careers.sophos.com/',
  'Juniper Networks|https://careers.juniper.net/',
  'Analog Devices|https://careers.analog.com/',
  'Roche|https://careers.roche.com/',
  'Novartis|https://careers.novartis.com/',
  'Warner Bros. Discovery|https://careers.wbd.com/',
  'Zillow|https://careers.zillowgroup.com/',
  'NTT Data|https://www.nttdata.com/global/en/careers',
  'Rakuten|https://japan-job-en.rakuten.careers/search-jobs',
  'MUFG|https://www.mufg.jp/english/careers/',
  'Tencent|https://tencent.wd1.myworkdayjobs.com/Tencent_Careers',
  'BYD Europe|https://careers.bydeurope.com/',
  'Blizzard|https://careers.blizzard.com/',
  'Activision Blizzard|https://careers.activisionblizzard.com/',
  'CD Projekt Red|https://www.cdprojektred.com/en/jobs/',
  'King|https://careers.king.com/',
  'People Can Fly|https://careers.peoplecanfly.com/',
  'Embark Studios|https://careers.embark-studios.com/',
  'Crytek|https://www.crytek.com/career',
  'PlayStation|https://careers.playstation.com/',
  'Bungie|https://www.bungie.net/careers',
  'Boosta|https://boosta.biz/careers/',
  'SoftServe|https://career.softserveinc.com/en-us/vacancies',
  'Sigma Software|https://career.sigma.software/',
  'Levi9 Ukraine|https://jobs.ua.levi9.com/',
  'Ecommpay|https://careers.ecommpay.com/',
].join(',')

const DEFAULT_DOU_COMPANIES = [
  'macpaw:MacPaw', 'uklon:Uklon', 'genesis-technology-partners:Genesis',
].join(',')

type HostedKind = 'greenhouse' | 'lever' | 'smartrecruiters' | 'ashby'
type HostedBoard = { handle: string; label: string }
type CareerPage = { label: string; url: string }

type CompanyTarget =
  | { kind: HostedKind; key: string; handle: string; label: string }
  | { kind: 'career'; key: string; label: string; url: string }
  | { kind: 'dou'; key: string; handle: string; label: string }

function stripHtml(value: unknown): string {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function prettyLabel(token: string): string {
  return token.charAt(0).toUpperCase() + token.slice(1)
}

function parseBoards(raw: string): HostedBoard[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [handle = '', label] = entry.split(':')
      return { handle: handle.trim(), label: (label || prettyLabel(handle)).trim() }
    })
    .filter((board) => board.handle)
}

const SEED_BY_KIND: Record<HostedKind, string> = {
  greenhouse: DEFAULT_GREENHOUSE,
  lever: DEFAULT_LEVER,
  smartrecruiters: DEFAULT_SMARTRECRUITERS,
  ashby: DEFAULT_ASHBY,
}

const ENV_BY_KIND: Record<HostedKind, string> = {
  greenhouse: 'GREENHOUSE_BOARDS',
  lever: 'LEVER_COMPANIES',
  smartrecruiters: 'SMARTRECRUITERS_COMPANIES',
  ashby: 'ASHBY_COMPANIES',
}

function hostedBoards(kind: HostedKind): HostedBoard[] {
  const seed = process.env.COMPANIES_DEFAULTS === 'off' ? '' : SEED_BY_KIND[kind]
  const env = process.env[ENV_BY_KIND[kind]]
  return parseBoards([seed, env || ''].filter(Boolean).join(','))
}

function careerPages(): CareerPage[] {
  const parts: string[] = []
  if (process.env.COMPANIES_DEFAULTS !== 'off') parts.push(DEFAULT_CAREERS_PAGES)
  if (process.env.CAREERS_PAGES) parts.push(process.env.CAREERS_PAGES)
  return parts
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf('|')
      const label = i > 0 ? entry.slice(0, i).trim() : ''
      const url = (i > 0 ? entry.slice(i + 1) : entry).trim()
      return { label, url }
    })
    .filter((page) => /^https?:\/\//.test(page.url))
    .map((page) => ({
      url: page.url,
      label: page.label || new URL(page.url).hostname.replace(/^(careers|jobs|www)\./, ''),
    }))
}

function douCompanies(): HostedBoard[] {
  const seed = process.env.COMPANIES_DEFAULTS === 'off' ? '' : DEFAULT_DOU_COMPANIES
  return parseBoards([seed, process.env.DOU_COMPANIES || ''].filter(Boolean).join(','))
}

function slug(value: string): string {
  return value.toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function configuredTargets(): CompanyTarget[] {
  const targets: CompanyTarget[] = []
  for (const kind of ['greenhouse', 'lever', 'smartrecruiters', 'ashby'] as HostedKind[]) {
    for (const board of hostedBoards(kind)) {
      targets.push({ kind, key: `${kind}:${board.handle}`, ...board })
    }
  }
  for (const page of careerPages()) {
    targets.push({ kind: 'career', key: `career:${slug(page.label)}:${slug(new URL(page.url).hostname)}`, ...page })
  }
  for (const board of douCompanies()) {
    targets.push({ kind: 'dou', key: `dou:${board.handle}`, ...board })
  }
  return targets
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'User-Agent': API_UA, Accept: 'application/json', ...(init?.headers || {}) },
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.json() as Promise<T>
}

async function fetchJsonText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, {
    ...init,
    headers: { 'User-Agent': API_UA, Accept: 'application/json', ...(init?.headers || {}) },
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' },
  })
  if (!response.ok) throw new Error(`${new URL(url).host} -> ${response.status}`)
  return response.text()
}

function pageJobId(pageUrl: string, unique: string): string {
  return `companies-page-${new URL(pageUrl).hostname}-${unique}`
}

async function fetchGreenhouseBoard(handle: string, label: string): Promise<Job[]> {
  const data = await fetchJson<{ jobs?: any[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(handle)}/jobs?content=true`,
  )
  return (data.jobs || []).map((job) => {
    const location = job.location?.name || 'See listing'
    return {
      id: `companies-gh-${handle}-${job.id}`,
      title: job.title,
      company: label,
      location,
      url: job.absolute_url,
      source: 'companies' as const,
      remote: /remote|anywhere|distributed/i.test(`${job.title} ${location}`),
      tags: [label],
      postedAt: new Date(job.updated_at || Date.now()).toISOString(),
      description: stripHtml(job.content).slice(0, DESC_MAX),
    }
  })
}

async function fetchLeverBoard(handle: string, label: string): Promise<Job[]> {
  const data = await fetchJson<any[]>(
    `https://api.lever.co/v0/postings/${encodeURIComponent(handle)}?mode=json`,
  )
  return (data || []).map((job) => {
    const location = job.categories?.location || 'See listing'
    return {
      id: `companies-lever-${handle}-${job.id}`,
      title: job.text,
      company: label,
      location,
      url: job.hostedUrl,
      source: 'companies' as const,
      remote: /remote|anywhere|distributed/i.test(`${job.text} ${location}`),
      tags: [label, job.categories?.team].filter(Boolean),
      postedAt: new Date(job.createdAt || Date.now()).toISOString(),
      employmentType: job.categories?.commitment,
      description: stripHtml(job.descriptionPlain || job.description).slice(0, DESC_MAX),
    }
  })
}

function mapSmartRecruiters(raw: string, handle: string, label: string): Job[] {
  let data: { content?: any[] }
  try { data = JSON.parse(raw) as { content?: any[] } } catch { return [] }
  return (data.content || []).map((job) => {
    const location = job.location?.fullLocation
      || [job.location?.city, job.location?.country?.toUpperCase()].filter(Boolean).join(', ')
      || 'See listing'
    return {
      id: `companies-sr-${handle}-${job.id}`,
      title: job.name,
      company: job.company?.name || label,
      location,
      url: `https://jobs.smartrecruiters.com/${handle}/${job.id}`,
      source: 'companies' as const,
      remote: job.location?.remote === true || /remote|anywhere|distributed/i.test(`${job.name} ${location}`),
      tags: [label, job.function?.label, job.industry?.label].filter(Boolean),
      postedAt: new Date(job.releasedDate || Date.now()).toISOString(),
      employmentType: job.typeOfEmployment?.label,
    }
  })
}

async function fetchSmartRecruitersBoard(handle: string, label: string): Promise<Job[]> {
  const run = await crawlStandardJobBoard({
    key: `core-company:smartrecruiters:${handle}`,
    fetchPage: (page) => fetchJsonText(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(handle)}/postings?limit=100&offset=${(page - 1) * 100}`,
    ),
    parsePage: (raw) => mapSmartRecruiters(raw, handle, label),
  })
  return run.jobs
}

async function fetchAshbyBoard(handle: string, label: string): Promise<Job[]> {
  const data = await fetchJson<{ jobs?: any[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(handle)}`,
  )
  return (data.jobs || [])
    .filter((job) => job.isListed !== false)
    .map((job) => {
      const location = job.location
        || (job.secondaryLocations || []).map((item: any) => item.location).filter(Boolean).join(', ')
        || 'See listing'
      return {
        id: `companies-ashby-${handle}-${job.id}`,
        title: job.title,
        company: label,
        location,
        url: job.jobUrl || job.applyUrl,
        source: 'companies' as const,
        remote: job.isRemote === true
          || /remote/i.test(job.workplaceType || '')
          || /remote|anywhere|distributed/i.test(`${job.title} ${location}`),
        tags: [label, job.department, job.team].filter(Boolean),
        postedAt: new Date(job.publishedAt || Date.now()).toISOString(),
        employmentType: job.employmentType,
        description: stripHtml(job.descriptionPlain || job.descriptionHtml).slice(0, DESC_MAX),
      }
    })
}

function phenomParams(pageUrl: string): { country: string; lang: string } {
  const segments = new URL(pageUrl).pathname.split('/').filter(Boolean)
  for (let i = 0; i + 1 < segments.length; i++) {
    const country = segments[i]!
    const language = segments[i + 1]!
    if ((/^[a-z]{2}$/.test(country) || country === 'global') && /^[a-z]{2}$/.test(language)) {
      return { country, lang: `${language}_${country === 'global' ? 'global' : country}` }
    }
  }
  return { country: 'global', lang: 'en_global' }
}

function mapPhenomJob(job: any, pageUrl: string, label: string): Job {
  const location = (job.multi_location || []).join('; ')
    || job.cityStateCountry || job.location || job.country || 'See listing'
  return {
    id: pageJobId(pageUrl, String(job.jobSeqNo || job.jobId || job.reqId)),
    title: job.title,
    company: label,
    location,
    url: job.applyUrl || pageUrl,
    source: 'companies',
    remote: /remote/i.test(`${job.title} ${location} ${job.workHours || ''}`),
    tags: [label, ...(job.multi_category || [])].filter(Boolean).slice(0, 8),
    postedAt: new Date(job.postedDate || job.dateCreated || Date.now()).toISOString(),
    employmentType: job.workHours || job.contractType1,
    description: stripHtml(job.descriptionTeaser).slice(0, DESC_MAX),
  }
}

async function fetchPhenomJobs(pageUrl: string, label: string): Promise<Job[]> {
  const { country, lang } = phenomParams(pageUrl)
  const run = await crawlStandardJobBoard({
    key: `core-company:phenom:${slug(label)}`,
    fetchPage: async (page) => {
      const response = await fetch(`${new URL(pageUrl).origin}/widgets`, {
        method: 'POST',
        headers: { 'User-Agent': API_UA, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lang,
          country,
          deviceType: 'desktop',
          pageName: 'search-results',
          ddoKey: 'refineSearch',
          sortBy: 'Most recent',
          subsearch: '',
          from: (page - 1) * 100,
          jobs: true,
          counts: true,
          all_fields: ['category', 'country', 'state', 'city', 'type'],
          size: 100,
          clearAll: false,
          jdsource: 'facets',
          isSliderEnable: false,
          pageId: 'page10',
          siteType: 'external',
          keywords: '',
          global: true,
          selected_fields: {},
          locationData: {},
        }),
      })
      if (!response.ok) throw new Error(`${new URL(pageUrl).host} widgets -> ${response.status}`)
      return response.text()
    },
    parsePage: (raw) => {
      try {
        const data = JSON.parse(raw)
        return (data?.refineSearch?.data?.jobs || []).map((job: any) => mapPhenomJob(job, pageUrl, label))
      } catch {
        return []
      }
    },
  })
  return run.jobs
}

function workdayDescriptor(html: string): { base: string; tenant: string; site: string } | null {
  const match = html.match(
    /https:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Za-z]{2,5}\/)?([A-Za-z0-9_-]+)/,
  )
  if (!match?.[1] || !match[2] || !match[3] || match[3] === 'wday') return null
  return {
    base: `https://${match[1]}.${match[2]}.myworkdayjobs.com`,
    tenant: match[1],
    site: match[3],
  }
}

function workdayPostedAt(postedOn: string | undefined): string {
  const value = postedOn || ''
  let days = 30
  if (/today/i.test(value)) days = 0
  else if (/yesterday/i.test(value)) days = 1
  else {
    const match = /(\d+)\+?\s*days/i.exec(value)
    if (match) days = Number(match[1])
  }
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

async function fetchWorkdayJobs(
  descriptor: { base: string; tenant: string; site: string },
  pageUrl: string,
  label: string,
): Promise<Job[]> {
  const { base, tenant, site } = descriptor
  const run = await crawlStandardJobBoard({
    key: `core-company:workday:${slug(label)}`,
    fetchPage: async (page) => {
      const response = await fetch(`${base}/wday/cxs/${tenant}/${site}/jobs`, {
        method: 'POST',
        headers: { 'User-Agent': API_UA, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: (page - 1) * 20, searchText: '' }),
      })
      if (!response.ok) throw new Error(`${new URL(base).host} -> ${response.status}`)
      return response.text()
    },
    parsePage: (raw) => {
      let data: any
      try { data = JSON.parse(raw) } catch { return [] }
      return (data?.jobPostings || []).flatMap((post: any) => {
        if (!post?.title || !post?.externalPath) return []
        const location = post.locationsText || 'See listing'
        return [{
          id: pageJobId(pageUrl, String(post.bulletFields?.[0] || post.externalPath)),
          title: post.title,
          company: label,
          location,
          url: `${base}/${site}${post.externalPath}`,
          source: 'companies' as const,
          remote: /remote/i.test(`${post.title} ${location}`),
          tags: [label],
          postedAt: workdayPostedAt(post.postedOn),
        }]
      })
    },
  })

  return enrichStandardJobBoardDetails({
    key: `core-company:workday:${slug(label)}`,
    jobs: run.jobs,
    fetchDetail: async (job) => {
      const pathname = new URL(job.url).pathname
      const sitePrefix = `/${site}`
      const externalPath = pathname.startsWith(sitePrefix) ? pathname.slice(sitePrefix.length) : pathname
      return fetchJsonText(`${base}/wday/cxs/${tenant}/${site}${externalPath}`)
    },
    parseDetail: (raw, summary) => {
      try {
        const data = JSON.parse(raw)
        const info = data?.jobPostingInfo || {}
        const description = stripHtml(info.jobDescription || info.description || '')
        return {
          ...summary,
          employmentType: info.timeType || info.workerType || summary.employmentType,
          description: description || summary.description,
          ...extractSalaryFromText(description),
        }
      } catch {
        return summary
      }
    },
  })
}

async function fetchEmbeddedAts(html: string, label: string): Promise<Job[]> {
  let match = html.match(/boards\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]{2,})/i)
  if (match?.[1] && match[1] !== 'embed') return fetchGreenhouseBoard(match[1], label)
  match = html.match(/jobs\.(?:eu\.)?lever\.co\/([A-Za-z0-9_-]{2,})/)
  if (match?.[1]) return fetchLeverBoard(match[1], label)
  match = html.match(/jobs\.ashbyhq\.com\/([A-Za-z0-9_-]{2,})/)
  if (match?.[1]) return fetchAshbyBoard(match[1], label)
  match = html.match(/(?:careers|jobs)\.smartrecruiters\.com\/([A-Za-z0-9]{2,})/)
  if (match?.[1]) return fetchSmartRecruitersBoard(match[1], label)
  return []
}

function parseJsonLdJobs(html: string, pageUrl: string, label: string): Job[] {
  const out: Job[] = []
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    let data: any
    try { data = JSON.parse(match[1]!) } catch { continue }
    const nodes = Array.isArray(data) ? data : data?.['@graph'] || [data]
    for (const node of nodes) {
      const type = node?.['@type']
      const isPosting = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))
      if (!isPosting || !node.title) continue
      const locations = Array.isArray(node.jobLocation) ? node.jobLocation : [node.jobLocation].filter(Boolean)
      const location = locations
        .map((item: any) => [item?.address?.addressLocality, item?.address?.addressCountry].filter(Boolean).join(', '))
        .filter(Boolean)
        .join('; ') || 'See listing'
      const url = node.url || node.sameAs || pageUrl
      out.push({
        id: pageJobId(pageUrl, String(node.identifier?.value || node.identifier || url)),
        title: stripHtml(node.title),
        company: node.hiringOrganization?.name || label,
        location,
        url,
        source: 'companies',
        remote: node.jobLocationType === 'TELECOMMUTE' || /remote/i.test(`${node.title} ${location}`),
        tags: [label],
        postedAt: new Date(node.datePosted || Date.now()).toISOString(),
        employmentType: Array.isArray(node.employmentType) ? node.employmentType[0] : node.employmentType,
        description: stripHtml(node.description).slice(0, DESC_MAX),
      })
    }
  }
  return out
}

const JOB_PATH_RE = /\/(?:jobs?|vacanc\w*|positions?|openings?)\/(?:[a-z]{2}\/)?([^/?#]*\d[^/?#]*|[a-z0-9][a-z0-9-]{10,})\/?$/i

function slugTitle(href: string): string {
  const match = JOB_PATH_RE.exec(new URL(href).pathname)
  const value = (match?.[1] || '').replace(/^\d+-?/, '').replace(/[-_]+/g, ' ').trim()
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : ''
}

function parseJobAnchors(html: string, pageUrl: string, label: string): Job[] {
  const byHref = new Map<string, string>()
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    let href: string
    try { href = new URL(match[1]!, pageUrl).toString() } catch { continue }
    if (!JOB_PATH_RE.test(new URL(href).pathname)) continue
    const text = stripHtml(match[2])
    const previous = byHref.get(href)
    const usable = text.length >= 4 && text.length <= 120 && !/^(view|see|all|apply|read|learn|more)\b/i.test(text)
    if (previous === undefined) byHref.set(href, usable ? text : '')
    else if (usable && (!previous || text.length < previous.length)) byHref.set(href, text)
  }
  const now = new Date().toISOString()
  return [...byHref.entries()].flatMap(([href, text]) => {
    const title = text || slugTitle(href)
    if (!title) return []
    return [{
      id: pageJobId(pageUrl, href),
      title,
      company: label,
      location: 'See listing',
      url: href,
      source: 'companies' as const,
      remote: /remote/i.test(title),
      tags: [label],
      postedAt: now,
    }]
  })
}

async function fetchCareerPage(pageUrl: string, label: string): Promise<Job[]> {
  const html = await fetchHtml(pageUrl)
  if (/phApp\.ddo/.test(html)) {
    try {
      const jobs = await fetchPhenomJobs(pageUrl, label)
      if (jobs.length) return jobs
    } catch {
      const fallback = await fetchHtml(`${pageUrl.replace(/\/+$/, '')}/search-results`)
      const match = fallback.match(/phApp\.ddo\s*=\s*({[\s\S]*?});/)
      if (match?.[1]) {
        try {
          const jobs = JSON.parse(match[1])?.eagerLoadRefineSearch?.data?.jobs || []
          return jobs.map((job: any) => mapPhenomJob(job, pageUrl, label))
        } catch {
          // Continue to other page strategies.
        }
      }
    }
  }

  const workday = workdayDescriptor(html)
  if (workday) {
    const jobs = await fetchWorkdayJobs(workday, pageUrl, label)
    if (jobs.length) return jobs
  }

  const embedded = await fetchEmbeddedAts(html, label)
  if (embedded.length) return embedded
  const jsonLd = parseJsonLdJobs(html, pageUrl, label)
  return jsonLd.length ? jsonLd : parseJobAnchors(html, pageUrl, label)
}

const DOU_VACANCY_RE =
  /<a\s+href="([^"]*\/vacancies\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>\s*(?:<span class="cities">([^<]*)<\/span>)?/gi

async function fetchDouCompany(handle: string, label: string): Promise<Job[]> {
  const html = await fetchHtml(`https://jobs.dou.ua/companies/${encodeURIComponent(handle)}/`)
  const out: Job[] = []
  DOU_VACANCY_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = DOU_VACANCY_RE.exec(html))) {
    const href = match[1]!
    if (!href.includes(`/companies/${handle}/`)) continue
    const title = stripHtml(match[3])
    if (!title) continue
    const cities = (match[4] || '').replace(/^[,\s]+/, '').trim()
    out.push({
      id: `companies-dou-${handle}-${match[2]}`,
      title,
      company: label,
      location: cities ? `${cities}, Ukraine` : 'Ukraine',
      url: href.split('?')[0]!,
      source: 'companies',
      remote: /віддален|remote/i.test(cities),
      tags: [label],
      postedAt: new Date().toISOString(),
    })
  }
  return out
}

export const CORE_COMPANY_TARGET_PREFIX = 'core-company-source:'

export function configuredCoreCompanyTargets(): string[] {
  if (process.env.COMPANIES_SOURCE === 'off') return []
  return configuredTargets().map((target) => `${CORE_COMPANY_TARGET_PREFIX}${target.key}`)
}

export function isCoreCompanyTarget(target: string): boolean {
  return target.startsWith(CORE_COMPANY_TARGET_PREFIX)
}

export async function fetchCoreCompanyTarget(target: string): Promise<Job[]> {
  if (!isCoreCompanyTarget(target)) throw new Error(`Unknown core company target ${target}`)
  const key = target.slice(CORE_COMPANY_TARGET_PREFIX.length)
  const config = configuredTargets().find((candidate) => candidate.key === key)
  if (!config) throw new Error(`Unknown core company target ${target}`)

  if (config.kind === 'greenhouse') return fetchGreenhouseBoard(config.handle, config.label)
  if (config.kind === 'lever') return fetchLeverBoard(config.handle, config.label)
  if (config.kind === 'smartrecruiters') return fetchSmartRecruitersBoard(config.handle, config.label)
  if (config.kind === 'ashby') return fetchAshbyBoard(config.handle, config.label)
  if (config.kind === 'career') return fetchCareerPage(config.url, config.label)
  return fetchDouCompany(config.handle, config.label)
}
