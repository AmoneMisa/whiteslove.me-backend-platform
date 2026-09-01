import { cityFrom } from './webFields'

const PROFILE_COLUMN_RE = /<div\b[^>]*class=["'][^"']*\bw-full\b[^"']*\blg:w-2\/3\b[^"']*["'][^>]*>/iu
const SIDEBAR_COLUMN_RE = /<div\b[^>]*class=["'][^"']*\bw-full\b[^"']*\blg:w-1\/3\b[^"']*["'][^>]*>/iu

/** Keeps the CV column and drops navigation, ads, sidebar, footer and auth UI. */
export function ishBorProfileHtml(html: string): string {
  const profile = PROFILE_COLUMN_RE.exec(html)
  if (profile?.index != null) {
    const from = profile.index
    const afterProfileStart = html.slice(from + profile[0].length)
    const sidebar = SIDEBAR_COLUMN_RE.exec(afterProfileStart)
    if (sidebar?.index != null) return html.slice(from, from + profile[0].length + sidebar.index)
  }

  // Safe fallback for a future layout rename: begin at the profile heading and
  // at least stop before the footer/auth forms instead of storing the full page.
  const heading = html.search(/<h1\b/iu)
  if (heading >= 0) {
    const tail = html.slice(heading)
    const boundary = tail.search(/<(?:footer)\b|<div\b[^>]*id=["']authModal["']/iu)
    return boundary >= 0 ? tail.slice(0, boundary) : tail
  }
  return html
}

/** Repairs full-page text already persisted by the old IshBor adapter. */
export function trimIshBorProfileText(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const citiesModal = lines.findIndex((line) => /^Города и области$/iu.test(line))
  const start = citiesModal >= 0 ? citiesModal + 1 : 0
  const boilerplate = lines.findIndex((line, index) => index >= start && (
    /^Чтобы связаться с кандидатом/iu.test(line)
    || /^Для связи с кандидатом/iu.test(line)
    || /^Уже зарегистрированы\?/iu.test(line)
    || /^Нет аккаунта\?/iu.test(line)
  ))
  const footer = lines.findIndex((line, index) => index >= start && (
    /^ish[-\s]?bor\.uz$/iu.test(line)
    || /^Если вам нужна работа или работник/iu.test(line)
    || /^©\s*20\d{2}\s+ish-bor\.uz/iu.test(line)
  ))
  const boundaries = [boilerplate, footer].filter((index) => index >= 0)
  const end = boundaries.length ? Math.min(...boundaries) : undefined
  return lines.slice(start, end).join('\n').trim()
}

/** The page title and profile header are authoritative; SEO/footer prose is not. */
export function ishBorLocationFromText(text: string): string | null {
  const titleLocation = text.match(/\(\s*Резюме\s*\)\s*-\s*([^|\n]{2,80})/iu)?.[1]
  if (titleLocation) {
    const city = cityFrom(titleLocation, 'UZ')
    if (city) return city
  }
  const core = trimIshBorProfileText(text).split('\n').slice(0, 12).join('\n')
  return cityFrom(core, 'UZ')
}
