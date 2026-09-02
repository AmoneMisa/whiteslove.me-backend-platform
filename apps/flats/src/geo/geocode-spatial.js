const EARTH_RADIUS_M = 6_371_000;

function projectPoint(point, origin) {
  const lat0 = (origin.lat * Math.PI) / 180;
  return {
    x: ((point.lng - origin.lng) * Math.PI / 180) * EARTH_RADIUS_M * Math.cos(lat0),
    y: ((point.lat - origin.lat) * Math.PI / 180) * EARTH_RADIUS_M,
  };
}

function unprojectPoint(point, origin) {
  const lat0 = (origin.lat * Math.PI) / 180;
  return {
    lat: origin.lat + (point.y / EARTH_RADIUS_M) * (180 / Math.PI),
    lng: origin.lng + (point.x / (EARTH_RADIUS_M * Math.cos(lat0))) * (180 / Math.PI),
  };
}

function spatialResidual(point, anchors) {
  const squared = anchors.map((anchor) => {
    const distance = Math.hypot(point.x - anchor.x, point.y - anchor.y);
    return (distance - anchor.distanceM) ** 2;
  });
  return Math.sqrt(squared.reduce((sum, value) => sum + value, 0) / squared.length);
}

function circlePairCandidates(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.001) return [];

  const ux = dx / distance;
  const uy = dy / distance;
  const along = (a.distanceM ** 2 - b.distanceM ** 2 + distance ** 2) / (2 * distance);
  const base = { x: a.x + along * ux, y: a.y + along * uy };
  const heightSquared = a.distanceM ** 2 - along ** 2;

  if (heightSquared >= 0) {
    const height = Math.sqrt(heightSquared);
    return [
      { x: base.x - uy * height, y: base.y + ux * height },
      { x: base.x + uy * height, y: base.y - ux * height },
    ];
  }

  const edgeA = { x: a.x + ux * a.distanceM, y: a.y + uy * a.distanceM };
  const edgeB = { x: b.x - ux * b.distanceM, y: b.y - uy * b.distanceM };
  return [{ x: (edgeA.x + edgeB.x) / 2, y: (edgeA.y + edgeB.y) / 2 }];
}

export function solveSpatialPoint(rawAnchors, prior = null) {
  const anchors = (rawAnchors || []).filter(
    (anchor) => Number.isFinite(anchor?.lat) && Number.isFinite(anchor?.lng) && Number(anchor?.distanceM) > 0,
  );
  if (anchors.length < 2) return null;

  const origin = {
    lat: anchors.reduce((sum, anchor) => sum + anchor.lat, 0) / anchors.length,
    lng: anchors.reduce((sum, anchor) => sum + anchor.lng, 0) / anchors.length,
  };
  const localAnchors = anchors.map((anchor) => ({
    ...projectPoint(anchor, origin),
    distanceM: Number(anchor.distanceM),
  }));
  const priorLocal = prior && Number.isFinite(prior.lat) && Number.isFinite(prior.lng)
    ? projectPoint(prior, origin)
    : null;

  const candidates = [];
  for (let i = 0; i < localAnchors.length; i += 1) {
    for (let j = i + 1; j < localAnchors.length; j += 1) {
      candidates.push(...circlePairCandidates(localAnchors[i], localAnchors[j]));
    }
  }

  const totalWeight = localAnchors.reduce((sum, anchor) => sum + 1 / anchor.distanceM, 0);
  candidates.push({
    x: localAnchors.reduce((sum, anchor) => sum + anchor.x / anchor.distanceM, 0) / totalWeight,
    y: localAnchors.reduce((sum, anchor) => sum + anchor.y / anchor.distanceM, 0) / totalWeight,
  });
  if (priorLocal) candidates.push(priorLocal);

  let best = null;
  for (const candidate of candidates) {
    const residualM = spatialResidual(candidate, localAnchors);
    const priorPenalty = priorLocal ? Math.hypot(candidate.x - priorLocal.x, candidate.y - priorLocal.y) * 0.01 : 0;
    const score = residualM + priorPenalty;
    if (!best || score < best.score) best = { point: candidate, residualM, score };
  }
  if (!best) return null;

  return {
    ...unprojectPoint(best.point, origin),
    residualM: best.residualM,
    anchorCount: anchors.length,
  };
}
