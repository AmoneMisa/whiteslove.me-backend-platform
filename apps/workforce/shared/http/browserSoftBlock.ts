// Some protected sites answer blocked clients with an HTTP 200 challenge
// document. Callers must inspect the body before treating the fetch as a
// successful empty search result.
const SOFT_BLOCK_TITLE_RE =
  /<title[^>]*>[^<]*(?:recaptcha|captcha|just a moment|attention required|access denied|доступ ограничен|проверка браузера|verificare)/i
const SOFT_BLOCK_BODY_RE =
  /(?:g-recaptcha|grecaptcha\.|cf-browser-verification|challenge-platform|__cf_chl|hcaptcha\.com\/captcha)/i

/** True when a 200 response carries a challenge rather than the page. */
export function looksSoftBlocked(html: string): boolean {
  if (!html) return false
  const head = html.slice(0, 4_000)
  if (SOFT_BLOCK_TITLE_RE.test(head)) return true
  // A real page that merely embeds a captcha widget is much larger than the
  // interstitial that replaces it, so size keeps false positives down.
  return html.length < 120_000 && SOFT_BLOCK_BODY_RE.test(head)
}
