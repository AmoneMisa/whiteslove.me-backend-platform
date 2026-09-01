// OLX Playwright viability probe — DIAGNOSTIC ONLY.
//
// Run this ON THE SERVER whose IP OLX is blocking. It launches a real headless
// Chromium, loads each OLX portal, lets DataDome's JS run, and reports whether:
//   - the page loads normally,
//   - a bot challenge / CAPTCHA is shown (we DETECT it; we never solve it),
//   - a `datadome` cookie was granted,
//   - the private /api/v1/offers/ endpoint then returns 200 with data.
//
// Decision guide from the output:
//   API 200 + rows + no captcha  -> Playwright is viable; worth building the
//                                    real integration (browser gets the cookie).
//   captcha detected             -> NOT viable without solving CAPTCHAs, which we
//                                    won't do. Use a residential proxy instead.
//   nav blocked / API 403        -> browser didn't clear the WAF; not viable here.
//
// Setup on the server (Node 18+):
//   cd flat-finder/backend
//   npm i -D playwright           # or: npm i -g playwright
//   npx playwright install chromium
//   node scripts/olx-playwright-probe.mjs           # all portals
//   node scripts/olx-playwright-probe.mjs uz        # one portal

import { chromium } from 'playwright';

const HOSTS = {
  ro: 'https://www.olx.ro',
  ua: 'https://www.olx.ua',
  kz: 'https://www.olx.kz',
  uz: 'https://www.olx.uz',
};
const LANG = { ro: 'ro-RO', ua: 'uk-UA', kz: 'ru-RU', uz: 'ru-RU' };

const only = process.argv[2]?.toLowerCase();
const tlds = only && HOSTS[only] ? [only] : Object.keys(HOSTS);

async function probe(tld) {
  const host = HOSTS[tld];
  const result = { tld, nav: null, captcha: false, datadome: false, api: null, apiRows: null, note: '' };
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ locale: LANG[tld], viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(`${host}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      result.nav = resp?.status() ?? null;
    } catch (err) {
      result.note = `nav error: ${err.message}`;
      return result;
    }
    // Give DataDome's JS time to run and set its cookie (or show a challenge).
    await page.waitForTimeout(5_000);

    result.captcha = await page.evaluate(() => {
      const hasCaptchaFrame = !!document.querySelector('iframe[src*="captcha-delivery.com"], iframe[src*="datadome"]');
      const text = (document.body?.innerText || '').toLowerCase();
      const phrases = ['captcha', 'are you a human', 'confirm you are', 'доступ ограничен', 'подтвердите', 'ти людина', 'ви людина'];
      return hasCaptchaFrame || phrases.some((p) => text.includes(p));
    });

    const cookies = await ctx.cookies();
    result.datadome = cookies.some((c) => c.name === 'datadome' && c.value);

    // Try the private API from inside the page so it carries the datadome cookie.
    const api = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/v1/offers/?offset=0&limit=3&sort_by=created_at:desc', { headers: { Accept: 'application/json' } });
        let rows = null;
        try { const j = await r.json(); rows = Array.isArray(j?.data) ? j.data.length : null; } catch { /* non-JSON */ }
        return { status: r.status, rows };
      } catch (e) {
        return { status: 'fetch-error', rows: null, error: String(e) };
      }
    });
    result.api = api.status;
    result.apiRows = api.rows;
    if (api.error) result.note = api.error;
    return result;
  } finally {
    await browser.close();
  }
}

function verdict(r) {
  if (r.captcha) return 'CAPTCHA — not viable (we do not solve these)';
  if (r.api === 200 && r.apiRows) return 'VIABLE — browser cleared the WAF and API returned data';
  if (r.api === 200) return 'partial — API 200 but no rows (check filters/category)';
  if (r.api === 403 || r.nav === 403) return 'BLOCKED — WAF still 403 even via real browser';
  return 'inconclusive — see fields';
}

console.log('OLX Playwright probe — diagnostic only, never solves challenges\n');
for (const tld of tlds) {
  try {
    const r = await probe(tld);
    console.log(
      `olx.${tld}  nav=${r.nav}  captcha=${r.captcha}  datadome=${r.datadome}  api=${r.api}  rows=${r.apiRows}`
      + (r.note ? `  note="${r.note}"` : ''),
    );
    console.log(`   -> ${verdict(r)}\n`);
  } catch (err) {
    console.log(`olx.${tld}  probe crashed: ${err.message}\n`);
  }
}
process.exit(0);
