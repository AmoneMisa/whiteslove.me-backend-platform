/**
 * JSON text PostgreSQL's json/jsonb input will accept.
 *
 * JavaScript strings may hold an unpaired UTF-16 surrogate -- typically half
 * an emoji left behind when scraped text is truncated -- and JSON.stringify
 * writes it as a `\udXXX` escape. PostgreSQL rejects that ("Unicode low
 * surrogate must follow a high surrogate"), and NUL ("\u0000") as well, and
 * one such character fails the whole statement: a single bad posting kept
 * every vacancy batch out of the database for a week. Unpaired surrogates
 * become U+FFFD and NULs are dropped, so the rest of the text survives.
 */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu

export function postgresSafeString(value: string): string {
  return value.replace(UNPAIRED_SURROGATE, '�').replace(/\u0000/gu, '')
}

export function toPostgresJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'string' ? postgresSafeString(item) : item))
}
