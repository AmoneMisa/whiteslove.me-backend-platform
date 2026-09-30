// FOSSGIS serves the routing API on valhalla1; valhalla.openstreetmap.de now
// serves only the demo web app and answers every API POST with 405. The old
// host is still what .env.example suggested, so a configured value pointing
// at it is rewritten rather than trusted.
const DEFAULT_VALHALLA_URL = 'https://valhalla1.openstreetmap.de';
const RETIRED_VALHALLA_URLS = new Set(['https://valhalla.openstreetmap.de', 'http://valhalla.openstreetmap.de']);
const DEFAULT_TIMEOUT_MS = 3000;
// After a failure, skip routing briefly: a dead router otherwise costs every
// listing popup a full request (it cost ~0.8s each while returning 405).
const FAILURE_COOLDOWN_MS = Math.max(0, Number(process.env.VALHALLA_FAILURE_COOLDOWN_MS) || 5 * 60_000);
let failedUntil = 0;

function finiteCoordinate(point) {
  if (!point || point.lat == null || point.lng == null || point.lat === '' || point.lng === '') return false;
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= -90
    && lat <= 90
    && lng >= -180
    && lng <= 180;
}

function normalizedBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'off' || raw.toLowerCase() === 'disabled') return null;
  const url = raw.replace(/\/+$/, '');
  return RETIRED_VALHALLA_URLS.has(url.toLowerCase()) ? DEFAULT_VALHALLA_URL : url;
}

function timeoutMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : DEFAULT_TIMEOUT_MS;
}

/**
 * Returns one pedestrian distance/time result per target. Null cells mean
 * Valhalla could not build a pedestrian path for that target.
 */
export async function fetchWalkingMatrix(
  origin,
  targets,
  {
    baseUrl = process.env.VALHALLA_URL || DEFAULT_VALHALLA_URL,
    requestTimeoutMs = process.env.VALHALLA_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    now = Date.now(),
  } = {},
) {
  if (!finiteCoordinate(origin) || !Array.isArray(targets) || !targets.length) return [];
  if (typeof fetchImpl !== 'function') return targets.map(() => null);
  if (now < failedUntil) return targets.map(() => null);

  const validTargets = targets.map((target) => finiteCoordinate(target) ? target : null);
  const routableTargets = validTargets.filter(Boolean);
  if (!routableTargets.length) return targets.map(() => null);

  const url = normalizedBaseUrl(baseUrl);
  if (!url) return targets.map(() => null);

  let response;
  try {
    response = await fetchImpl(`${url}/sources_to_targets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sources: [{ lat: Number(origin.lat), lon: Number(origin.lng) }],
        targets: routableTargets.map((target) => ({
          lat: Number(target.lat),
          lon: Number(target.lng),
        })),
        costing: 'pedestrian',
        units: 'kilometers',
        verbose: true,
      }),
      signal: AbortSignal.timeout(timeoutMs(requestTimeoutMs)),
    });
  } catch (error) {
    failedUntil = now + FAILURE_COOLDOWN_MS;
    throw error;
  }

  if (!response.ok) {
    failedUntil = now + FAILURE_COOLDOWN_MS;
    throw new Error(`Valhalla matrix request failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const row = Array.isArray(payload?.sources_to_targets?.[0])
    ? payload.sources_to_targets[0]
    : [];

  let routableIndex = 0;
  return validTargets.map((target) => {
    if (!target) return null;
    const cell = row[routableIndex++];
    const distanceKm = Number(cell?.distance);
    const durationSeconds = Number(cell?.time);
    if (!Number.isFinite(distanceKm) || distanceKm < 0 || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
      return null;
    }
    return {
      distanceM: Math.round(distanceKm * 1000),
      durationMin: Math.max(1, Math.ceil(durationSeconds / 60)),
    };
  });
}

export const __walkingRoutingTest = {
  DEFAULT_VALHALLA_URL,
  DEFAULT_TIMEOUT_MS,
  resetFailureCooldown: () => { failedUntil = 0; },
  finiteCoordinate,
  normalizedBaseUrl,
  timeoutMs,
};
