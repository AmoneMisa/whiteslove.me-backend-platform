#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "Usage: $0 <service> [service ...]" >&2
  exit 64
fi

mapfile -t known_services < <(docker compose config --services)

contains_service() {
  local requested="$1"
  local known
  for known in "${known_services[@]}"; do
    [[ "$known" == "$requested" ]] && return 0
  done
  return 1
}

for service in "$@"; do
  if ! contains_service "$service"; then
    echo "Unknown Compose service: $service" >&2
    exit 64
  fi
done

# Pull and recreate only the requested processes. Dependencies such as
# PostgreSQL, Elasticsearch and AI gateways have their own deploy lifecycle.
docker compose pull "$@"
docker compose up -d --no-deps --remove-orphans=false "$@"

