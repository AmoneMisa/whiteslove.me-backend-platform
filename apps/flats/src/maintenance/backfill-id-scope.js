const MAX_IDS = 500;
const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;

export function parseBackfillIds(value, name = '--ids') {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error(`${name} requires a comma-separated list of positive database IDs`);

  const result = [];
  const seen = new Set();
  for (const token of raw.split(',')) {
    const id = token.trim();
    if (!/^[1-9]\d*$/.test(id)) {
      throw new Error(`${name} contains an invalid database ID: ${JSON.stringify(token)}`);
    }

    let bigint;
    try {
      bigint = BigInt(id);
    } catch {
      throw new Error(`${name} contains an invalid database ID: ${JSON.stringify(token)}`);
    }
    if (bigint > MAX_PG_BIGINT) {
      throw new Error(`${name} contains a database ID outside PostgreSQL bigint range: ${id}`);
    }

    const canonical = bigint.toString();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
    if (result.length > MAX_IDS) {
      throw new Error(`${name} supports at most ${MAX_IDS} database IDs per run`);
    }
  }

  return Object.freeze(result);
}

export function describeBackfillIds(ids) {
  return Array.isArray(ids) && ids.length ? ids.join(',') : 'ALL';
}
