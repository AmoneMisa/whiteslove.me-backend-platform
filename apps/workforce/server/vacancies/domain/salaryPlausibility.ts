// A vacancy's salary_usd is an ANNUAL figure so that boards quoting hourly, monthly and yearly pay
// sort and aggregate together. The period a source (or its text) names is sometimes wrong for the
// number it carries: "100 000 – 167 000 USD / month" is a yearly pay, "16 USD" is an hourly wage
// filed as yearly, and a CIS board's "25 000 ₸" is a monthly figure. These bounds keep a
// mis-labelled period from becoming a 1.6M-dollar or a 16-dollar year.
export type PayPeriod = 'hour' | 'month' | 'year'

export const MIN_ANNUAL_SALARY_USD = 500
export const MAX_ANNUAL_SALARY_USD = 1_000_000
const HOURS_PER_YEAR = 12 * 160

// Monthly pay above this is not a month: it is a yearly amount labelled monthly.
const MAX_PLAUSIBLE_MONTHLY_USD = 80_000
// Hourly pay above this is not an hour.
const MAX_PLAUSIBLE_HOURLY_USD = 500
// A "yearly" amount this small is an hourly wage; below the floor it is not a wage at all.
const MIN_PLAUSIBLE_HOURLY_USD = 8
const MAX_HOURLY_WAGE_MISTAKEN_FOR_YEAR_USD = 400

const MONTHS = 12

// A small "yearly" amount in one of these is an hourly wage; in a local currency (KZT, UZS, KGS, UAH…) it is a
// monthly one, since those boards quote pay per month.
const HARD_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'PLN', 'JPY'])

export interface AnnualSalary {
  usd: number
  period: PayPeriod
}

/** `amountUsd` is the salary midpoint in USD as quoted for `period`. Returns undefined when no honest annual figure exists. */
export function annualSalaryUsd(amountUsd: number | undefined, period: PayPeriod, currency?: string): AnnualSalary | undefined {
  if (amountUsd === undefined || !Number.isFinite(amountUsd) || amountUsd <= 0) return undefined

  let effective = period
  if (period === 'month' && amountUsd > MAX_PLAUSIBLE_MONTHLY_USD) effective = 'year'
  else if (period === 'hour' && amountUsd > MAX_PLAUSIBLE_HOURLY_USD) effective = 'year'
  else if (period === 'year' && amountUsd < MAX_HOURLY_WAGE_MISTAKEN_FOR_YEAR_USD) {
    if (amountUsd < MIN_PLAUSIBLE_HOURLY_USD) return undefined
    effective = HARD_CURRENCIES.has(String(currency || '').toUpperCase()) ? 'hour' : 'month'
  }

  const factor = effective === 'hour' ? HOURS_PER_YEAR : effective === 'month' ? MONTHS : 1
  const usd = Math.round(amountUsd * factor)
  if (usd < MIN_ANNUAL_SALARY_USD || usd > MAX_ANNUAL_SALARY_USD) return undefined
  return { usd, period: effective }
}
