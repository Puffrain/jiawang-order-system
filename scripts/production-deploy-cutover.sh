#!/bin/sh
set -eu

: "${PRODUCTION_DEPLOY_APPROVED:?set PRODUCTION_DEPLOY_APPROVED=true only after owner preview approval}"
: "${APPROVAL_REFERENCE:?set APPROVAL_REFERENCE to the recorded owner approval}"
: "${RELEASE_ID:?set RELEASE_ID}"
: "${CANDIDATE_DIR:?set CANDIDATE_DIR}"
: "${DEPLOY_OVERRIDE:?set DEPLOY_OVERRIDE from production-deploy-prepare.sh}"
: "${BACKUP_DIR:?set BACKUP_DIR from production-deploy-backup.sh}"
APP_DIR=${APP_DIR:-/opt/jiawang-commerce-new}
HEALTH_BASE_URL=${HEALTH_BASE_URL:-http://127.0.0.1:8080}
test "$PRODUCTION_DEPLOY_APPROVED" = true || { echo OWNER_APPROVAL_REQUIRED >&2; exit 43; }
test -n "$APPROVAL_REFERENCE" && test -f "$BACKUP_DIR/SHA256SUMS" && test -f "$DEPLOY_OVERRIDE"
test -f "$CANDIDATE_DIR/proxy/integration.conf"
(cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS)

rollback() {
  cp "$BACKUP_DIR/compose.yaml" "$APP_DIR/compose.yaml"
  cp "$BACKUP_DIR/compose.images.yaml" "$APP_DIR/compose.images.yaml"
  cp "$BACKUP_DIR/integration.conf" "$APP_DIR/proxy/integration.conf"
  (cd "$APP_DIR" && docker compose --env-file .env -f compose.yaml -f compose.images.yaml up -d --no-build --force-recreate)
}
install -m 644 "$CANDIDATE_DIR/compose.yaml" "$APP_DIR/compose.yaml"
install -m 644 "$DEPLOY_OVERRIDE" "$APP_DIR/compose.images.yaml"
install -m 644 "$CANDIDATE_DIR/proxy/integration.conf" "$APP_DIR/proxy/integration.conf"
cd "$APP_DIR"
if ! docker compose --env-file .env -f compose.yaml -f compose.images.yaml up -d --no-build --force-recreate; then rollback; echo CUTOVER_FAILED_ROLLED_BACK >&2; exit 1; fi
attempt=0
while [ "$attempt" -lt 24 ]; do
  if curl -fsS "$HEALTH_BASE_URL/api/health" >/dev/null 2>&1 && curl -fsS "$HEALTH_BASE_URL/warehouse/api/health" >/dev/null 2>&1; then break; fi
  attempt=$((attempt + 1)); sleep 5
done
if [ "$attempt" -ge 24 ]; then rollback; echo HEALTH_FAILED_ROLLED_BACK >&2; exit 1; fi
docker compose --env-file .env -f compose.yaml -f compose.images.yaml ps
printf 'CUTOVER_HEALTHY RELEASE_ID=%s APPROVAL_REFERENCE=%s\n' "$RELEASE_ID" "$APPROVAL_REFERENCE"
