#!/bin/sh
set -eu

: "${PRODUCTION_DEPLOY_APPROVED:?set PRODUCTION_DEPLOY_APPROVED=true only after owner approval}"
: "${APPROVAL_REFERENCE:?set APPROVAL_REFERENCE}"
: "${RELEASE_ID:?set RELEASE_ID}"
: "${BACKUP_DIR:?set BACKUP_DIR from production-deploy-backup.sh}"
test "$PRODUCTION_DEPLOY_APPROVED" = true || { echo OWNER_APPROVAL_REQUIRED >&2; exit 43; }
case "$RELEASE_ID" in *[!a-zA-Z0-9._-]*|'') echo "invalid RELEASE_ID" >&2; exit 2;; esac

PROJECT_NAME=${PROJECT_NAME:-jiawang-commerce}
ORDER_CONTAINER=${ORDER_CONTAINER:-${PROJECT_NAME}-order-web-1}
ORDER_WORKER_CONTAINER=${ORDER_WORKER_CONTAINER:-${PROJECT_NAME}-order-media-worker-1}
WAREHOUSE_WEB_CONTAINER=${WAREHOUSE_WEB_CONTAINER:-${PROJECT_NAME}-warehouse-web-1}
WAREHOUSE_WORKER_CONTAINER=${WAREHOUSE_WORKER_CONTAINER:-${PROJECT_NAME}-warehouse-worker-1}
HEALTH_BASE_URL=${HEALTH_BASE_URL:-http://127.0.0.1:8080}
LOG_SINCE=${LOG_SINCE:-10m}
LOG_ERROR_PATTERN=${LOG_ERROR_PATTERN:-error|fatal|exception|failed|uncaught|unhandled|panic}
LOG_MATCHES_APPROVED=${LOG_MATCHES_APPROVED:-false}
MAX_PENDING_MEDIA=${MAX_PENDING_MEDIA:-0}
MAX_FAILED_MEDIA=${MAX_FAILED_MEDIA:-0}
MAX_MISSING_IMAGES=${MAX_MISSING_IMAGES:-0}
MAX_SYNC_PENDING=${MAX_SYNC_PENDING:-0}
MAX_SYNC_DEAD=${MAX_SYNC_DEAD:-0}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

command -v docker >/dev/null 2>&1 || { echo DOCKER_UNAVAILABLE >&2; exit 3; }
command -v curl >/dev/null 2>&1 || { echo CURL_UNAVAILABLE >&2; exit 3; }
command -v sha256sum >/dev/null 2>&1 || { echo SHA256SUM_UNAVAILABLE >&2; exit 3; }
test -f "$BACKUP_DIR/SHA256SUMS"
(cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS)
curl -fsS "$HEALTH_BASE_URL/api/health" >/dev/null
curl -fsS "$HEALTH_BASE_URL/warehouse/api/health" >/dev/null

for container in "$ORDER_CONTAINER" "$ORDER_WORKER_CONTAINER" "$WAREHOUSE_WEB_CONTAINER" "$WAREHOUSE_WORKER_CONTAINER"; do
  test "$(docker inspect "$container" --format '{{.State.Status}}')" = running
done

cleanup() {
  docker exec "$ORDER_CONTAINER" rm -f /app/production-data-check.cjs >/dev/null 2>&1 || true
  docker exec "$WAREHOUSE_WORKER_CONTAINER" rm -f /app/production-data-check.cjs >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker cp "$SCRIPT_DIR/production-data-check.cjs" "$ORDER_CONTAINER:/app/production-data-check.cjs"
docker cp "$SCRIPT_DIR/production-data-check.cjs" "$WAREHOUSE_WORKER_CONTAINER:/app/production-data-check.cjs"
docker exec -e UPLOAD_DIR=/data/uploads -e MAX_PENDING_MEDIA="$MAX_PENDING_MEDIA" -e MAX_FAILED_MEDIA="$MAX_FAILED_MEDIA" -e MAX_MISSING_IMAGES="$MAX_MISSING_IMAGES" "$ORDER_CONTAINER" node /app/production-data-check.cjs order /data/app.db
docker exec -e MAX_SYNC_PENDING="$MAX_SYNC_PENDING" -e MAX_SYNC_DEAD="$MAX_SYNC_DEAD" "$WAREHOUSE_WORKER_CONTAINER" node /app/production-data-check.cjs warehouse /data/db/app.sqlite
cleanup
trap - EXIT INT TERM

log_matches=0
for container in "$ORDER_CONTAINER" "$ORDER_WORKER_CONTAINER" "$WAREHOUSE_WEB_CONTAINER" "$WAREHOUSE_WORKER_CONTAINER"; do
  echo "LOG_CHECK=$container"
  log_file=$(mktemp)
  docker logs --since "$LOG_SINCE" "$container" >"$log_file" 2>&1
  if grep -Ei "$LOG_ERROR_PATTERN" "$log_file"; then log_matches=1; fi
  rm -f "$log_file"
done
if [ "$log_matches" -ne 0 ] && [ "$LOG_MATCHES_APPROVED" != true ]; then
  echo "FINALIZE_FAILED critical log matches require investigation or LOG_MATCHES_APPROVED=true with recorded approval" >&2
  exit 1
fi
printf 'FINALIZE_PASS RELEASE_ID=%s APPROVAL_REFERENCE=%s\n' "$RELEASE_ID" "$APPROVAL_REFERENCE"
