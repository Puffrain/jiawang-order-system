#!/bin/sh
set -eu

ROOT_DIR=${ROOT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
: "${PREVIEW_ID:?set PREVIEW_ID}"
: "${PREVIEW_ENV_FILE:?set PREVIEW_ENV_FILE}"
: "${ORDER_CANDIDATE_IMAGE:?set ORDER_CANDIDATE_IMAGE to an immutable digest}"
: "${WAREHOUSE_WEB_CANDIDATE_IMAGE:?set WAREHOUSE_WEB_CANDIDATE_IMAGE to an immutable digest}"
: "${WAREHOUSE_WORKER_CANDIDATE_IMAGE:?set WAREHOUSE_WORKER_CANDIDATE_IMAGE to an immutable digest}"

cd "$ROOT_DIR"
command -v docker >/dev/null 2>&1 || { echo DOCKER_UNAVAILABLE; exit 3; }
docker compose version >/dev/null 2>&1 || { echo DOCKER_COMPOSE_UNAVAILABLE; exit 3; }
node scripts/validate-compose-build.mjs
sh scripts/validate-isolated-preview.sh
docker compose --env-file "$PREVIEW_ENV_FILE" -f compose.preview.yaml up -d --no-build --force-recreate
docker compose --env-file "$PREVIEW_ENV_FILE" -f compose.preview.yaml ps
