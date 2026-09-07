#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "Usage: $0 <service> [service ...]" >&2
  exit 64
fi

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.geo.yml)
mapfile -t known_services < <("${COMPOSE[@]}" config --services)

contains_service() {
  local requested="$1"
  local known
  for known in "${known_services[@]}"; do
    [[ "$known" == "$requested" ]] && return 0
  done
  return 1
}

requested=("$@")
for service in "${requested[@]}"; do
  if ! contains_service "$service"; then
    echo "Unknown Compose service: $service" >&2
    exit 64
  fi
done

contains_requested() {
  local wanted="$1"
  local service
  for service in "${requested[@]}"; do
    [[ "$service" == "$wanted" ]] && return 0
  done
  return 1
}

dump_service_health() {
  local service="$1"
  local container_id
  container_id="$("${COMPOSE[@]}" ps -q "$service")"
  if [[ -n "$container_id" ]]; then
    echo "${service} container state:" >&2
    docker inspect -f '{{json .State}}' "$container_id" >&2 || true
  fi
  echo "${service} logs:" >&2
  "${COMPOSE[@]}" logs --tail=200 "$service" >&2 || true
}

wait_for_health() {
  local service="$1"
  local timeout_seconds="${2:-90}"
  local started=$SECONDS
  local container_id status

  container_id="$("${COMPOSE[@]}" ps -q "$service")"
  if [[ -z "$container_id" ]]; then
    echo "No container found for $service" >&2
    return 1
  fi

  while (( SECONDS - started < timeout_seconds )); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
    case "$status" in
      healthy|running)
        echo "$service readiness: $status"
        return 0
        ;;
      exited|dead)
        echo "$service stopped before becoming ready: $status" >&2
        dump_service_health "$service"
        return 1
        ;;
    esac
    sleep 1
  done

  echo "$service did not become ready within ${timeout_seconds}s" >&2
  dump_service_health "$service"
  return 1
}

probe_flats_api() {
  "${COMPOSE[@]}" exec -T flats-api node --input-type=module <<'NODE'
try {
  const response = await fetch('http://127.0.0.1:4000/health', {
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(`/health -> HTTP ${response.status}: ${body.slice(0, 1000)}`);
    process.exit(1);
  }
  const health = body ? JSON.parse(body) : null;
  if (health?.ok !== true || health?.postgres !== true) {
    console.error(`/health invalid payload: ${body.slice(0, 1000)}`);
    process.exit(1);
  }
  console.log(body);
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
}
NODE
}

wait_for_flats_api() {
  local timeout_seconds="${1:-90}"
  local started=$SECONDS

  while (( SECONDS - started < timeout_seconds )); do
    if probe_flats_api >/dev/null 2>&1; then
      echo "flats-api readiness: /health OK"
      return 0
    fi
    sleep 2
  done

  echo "flats-api /health did not become ready within ${timeout_seconds}s" >&2
  echo "direct in-container probe:" >&2
  probe_flats_api >&2 || true
  dump_service_health flats-api
  return 1
}

smoke_flats_api() {
  "${COMPOSE[@]}" exec -T flats-api node --input-type=module <<'NODE'
const base = 'http://127.0.0.1:4000';

async function json(path, timeoutMs = 10_000) {
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} -> HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return body ? JSON.parse(body) : null;
}

const health = await json('/health', 5_000);
if (health?.ok !== true || health?.postgres !== true) {
  throw new Error(`/health is not ready: ${JSON.stringify(health)}`);
}

const countries = await json('/api/countries?locale=ru', 10_000);
if (!Array.isArray(countries) || countries.length === 0) {
  throw new Error('/api/countries returned no countries');
}

const uz = countries.find((country) => country?.code === 'UZ');
const tashkent = uz?.cities?.find((city) => String(city).toLowerCase() === 'tashkent');
if (!tashkent) {
  throw new Error('UZ/Tashkent is missing from the materialized country options');
}

const zones = await json(
  `/api/district-zones?country=UZ&city=${encodeURIComponent(tashkent)}&locale=ru`,
  15_000,
);
if (!zones || typeof zones !== 'object') {
  throw new Error('UZ/Tashkent district zones projection is empty');
}

console.log('flats-api smoke: health/countries/Tashkent zones OK');
NODE
}

# docker compose run can leave its one-shot container alive if the SSH client is
# killed by an outer timeout. That process keeps the session-scoped PostgreSQL
# advisory lock, so every later prewarm immediately fails as "locked". The
# publish workflow serializes production deploys, therefore any geo-sync
# one-off present at the start of a new deploy is stale and safe to terminate.
cleanup_geo_sync_runs() {
  local -a containers=()
  mapfile -t containers < <(
    docker ps -aq --filter 'label=com.docker.compose.service=flats-geo-sync'
  )
  if (( ${#containers[@]} == 0 )); then
    return 0
  fi

  echo "Removing stale flats-geo-sync container(s): ${containers[*]}"
  docker rm -f "${containers[@]}" >/dev/null
  # Let PostgreSQL observe the dead client and release its session advisory lock
  # before the replacement process attempts pg_try_advisory_lock().
  sleep 2
}

run_geo_prewarm() {
  local timeout_value="${FLATS_GEO_PREWARM_TIMEOUT:-20m}"
  local status=0

  cleanup_geo_sync_runs
  echo "geo prewarm server-side timeout: ${timeout_value}"

  # The server-side timeout is deliberately shorter than the SSH action's 30m
  # command timeout. If the build wedges, this shell gets control back and can
  # remove the one-shot container instead of leaving another lock holder behind.
  if timeout --signal=TERM --kill-after=30s "$timeout_value" \
    "${COMPOSE[@]}" run --rm --no-deps --name flats-geo-sync-prewarm flats-geo-sync; then
    return 0
  else
    status=$?
  fi

  echo "flats geo prewarm failed with status ${status}; cleaning one-shot container" >&2
  cleanup_geo_sync_runs
  return "$status"
}

# Pull only deploy-selected images. A flats API deployment also needs the same
# flats image for the one-shot geo prewarm service.
pull_services=("${requested[@]}")
if contains_requested flats-api; then
  pull_services+=(flats-geo-sync)
fi

unique_pull=()
for service in "${pull_services[@]}"; do
  duplicate=false
  for existing in "${unique_pull[@]:-}"; do
    if [[ "$existing" == "$service" ]]; then
      duplicate=true
      break
    fi
  done
  [[ "$duplicate" == true ]] || unique_pull+=("$service")
done
"${COMPOSE[@]}" pull "${unique_pull[@]}"

if contains_requested flats-api; then
  echo '=== flats phase 1/5: migrate schema ==='
  "${COMPOSE[@]}" run --rm --no-deps flats-migrate

  echo '=== flats phase 2/5: strict geo prewarm + projection verification ==='
  run_geo_prewarm

  echo '=== flats phase 3/5: cut over flats-api ==='
  "${COMPOSE[@]}" up -d --no-deps --remove-orphans=false flats-api
  wait_for_flats_api 90

  echo '=== flats phase 4/5: smoke materialized geo endpoints ==='
  smoke_flats_api

  echo '=== flats phase 5/5: cut over flats-worker ==='
  "${COMPOSE[@]}" up -d --no-deps --remove-orphans=false flats-worker
  wait_for_health flats-worker 90
fi

# Recreate the rest of the explicitly requested processes. The flats core
# services were already handled above in dependency-safe order.
remaining=()
for service in "${requested[@]}"; do
  if contains_requested flats-api; then
    case "$service" in
      flats-migrate|flats-geo-sync|flats-api|flats-worker)
        continue
        ;;
    esac
  fi
  remaining+=("$service")
done

if (( ${#remaining[@]} > 0 )); then
  "${COMPOSE[@]}" up -d --no-deps --remove-orphans=false "${remaining[@]}"
fi
