const DEFAULT_VALHALLA_URL = 'https://valhalla.openstreetmap.de';
const DEFAULT_TIMEOUT_MS = 3000;

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
  return raw.replace(/\/+$/, '');
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
  } = {},
) {
  if (!finiteCoordinate(origin) || !Array.isArray(targets) || !targets.length) return [];
  if (typeof fetchImpl !== 'function') return targets.map(() => null);

  const validTargets = targets.map((target) => finiteCoordinate(target) ? target : null);
  const routableTargets = validTargets.filter(Boolean);
  if (!routableTargets.length) return targets.map(() => null);

  const url = normalizedBaseUrl(baseUrl);
  if (!url) return targets.map(() => null);

  const response = await fetchImpl(`${url}/sources_to_targets`, {
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

  if (!response.ok) {
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
  finiteCoordinate,
  normalizedBaseUrl,
  timeoutMs,
};
