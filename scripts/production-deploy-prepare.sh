#!/bin/sh
set -eu

: "${RELEASE_ID:?set RELEASE_ID}"
: "${CANDIDATE_DIR:?set CANDIDATE_DIR to the reviewed source candidate}"
: "${ORDER_IMAGE:?set ORDER_IMAGE to an immutable image ID or repository digest}"
: "${WAREHOUSE_WEB_IMAGE:?set WAREHOUSE_WEB_IMAGE to an immutable image ID or repository digest}"
: "${WAREHOUSE_WORKER_IMAGE:?set WAREHOUSE_WORKER_IMAGE to an immutable image ID or repository digest}"
APP_DIR=${APP_DIR:-/opt/jiawang-commerce-new}
DEPLOY_OVERRIDE=${DEPLOY_OVERRIDE:-/tmp/compose.deploy-${RELEASE_ID}.yaml}
PROJECT_NAME=${PROJECT_NAME:-jiawang-commerce}
WAREHOUSE_WEB_CONTAINER=${WAREHOUSE_WEB_CONTAINER:-${PROJECT_NAME}-warehouse-web-1}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$RELEASE_ID" in *[!a-zA-Z0-9._-]*|'') echo "invalid RELEASE_ID" >&2; exit 2;; esac

command -v docker >/dev/null 2>&1 || { echo DOCKER_UNAVAILABLE >&2; exit 3; }
docker compose version >/dev/null 2>&1 || { echo DOCKER_COMPOSE_UNAVAILABLE >&2; exit 3; }
for image in "$ORDER_IMAGE" "$WAREHOUSE_WEB_IMAGE" "$WAREHOUSE_WORKER_IMAGE"; do
  case "$image" in sha256:????????????????????????????????????????????????????????????????|*@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "images must use immutable sha256 references" >&2; exit 2;; esac
  docker image inspect "$image" >/dev/null
done
test -f "$APP_DIR/.env" && test -f "$CANDIDATE_DIR/compose.yaml"
cd "$CANDIDATE_DIR"
node scripts/validate-compose-build.mjs
node scripts/deployment-config-smoke.mjs
node scripts/scan-secrets.mjs
current_master=$(docker inspect "$WAREHOUSE_WEB_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^APP_MASTER_KEY=//p')
next_master=$(sed -n 's/^APP_MASTER_KEY=//p' "$APP_DIR/.env")
test -n "$current_master" && test -n "$next_master"
test "$current_master" = "$next_master" || { echo APP_MASTER_KEY_CHANGED_BLOCK >&2; exit 42; }
cat > "$DEPLOY_OVERRIDE" <<EOF
services:
  order-volume-init:
    image: $ORDER_IMAGE
    build: null
  order-web:
    image: $ORDER_IMAGE
    build: null
  order-media-worker:
    image: $ORDER_IMAGE
    build: null
  warehouse-volume-init:
    image: $WAREHOUSE_WEB_IMAGE
    build: null
  warehouse-web:
    image: $WAREHOUSE_WEB_IMAGE
    build: null
  warehouse-worker:
    image: $WAREHOUSE_WORKER_IMAGE
    build: null
EOF
docker compose --env-file "$APP_DIR/.env" -f "$CANDIDATE_DIR/compose.yaml" -f "$DEPLOY_OVERRIDE" config --quiet
printf 'PREPARE_PASS RELEASE_ID=%s DEPLOY_OVERRIDE=%s\n' "$RELEASE_ID" "$DEPLOY_OVERRIDE"
