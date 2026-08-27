#!/bin/sh
set -eu

: "${RELEASE_ID:?set RELEASE_ID to the approved release identifier}"
case "$RELEASE_ID" in *[!a-zA-Z0-9._-]*|'') echo "invalid RELEASE_ID" >&2; exit 2;; esac
APP_DIR=${APP_DIR:-/opt/jiawang-commerce-new}
BACKUP_ROOT=${BACKUP_ROOT:-/root/jiawang-backups}
PROJECT_NAME=${PROJECT_NAME:-jiawang-commerce}
ORDER_CONTAINER=${ORDER_CONTAINER:-${PROJECT_NAME}-order-web-1}
WAREHOUSE_WORKER_CONTAINER=${WAREHOUSE_WORKER_CONTAINER:-${PROJECT_NAME}-warehouse-worker-1}
ORDER_DATA_VOLUME=${ORDER_DATA_VOLUME:-jiawang-commerce-order-data}
WAREHOUSE_MEDIA_VOLUME=${WAREHOUSE_MEDIA_VOLUME:-jiawang-commerce-warehouse-media}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
timestamp=$(date +%Y%m%d-%H%M%S)
backup_dir="$BACKUP_ROOT/${timestamp}-${RELEASE_ID}"

command -v docker >/dev/null 2>&1 || { echo DOCKER_UNAVAILABLE >&2; exit 3; }
command -v sha256sum >/dev/null 2>&1 || { echo SHA256SUM_UNAVAILABLE >&2; exit 3; }
test -d "$APP_DIR" && test -f "$APP_DIR/.env" && test -f "$APP_DIR/compose.yaml" && test -f "$APP_DIR/compose.images.yaml"
docker inspect "$ORDER_CONTAINER" "$WAREHOUSE_WORKER_CONTAINER" >/dev/null
docker volume inspect "$ORDER_DATA_VOLUME" >/dev/null
docker volume inspect "$WAREHOUSE_MEDIA_VOLUME" >/dev/null
install -d -m 700 "$backup_dir"
cd "$APP_DIR"
cp compose.yaml compose.images.yaml proxy/integration.conf "$backup_dir/"
install -m 600 .env "$backup_dir/.env.before"
docker inspect "$ORDER_CONTAINER" "$WAREHOUSE_WORKER_CONTAINER" --format '{{.Name}} {{.Config.Image}} {{.Image}}' > "$backup_dir/images.before.txt"

cleanup() {
  docker exec "$ORDER_CONTAINER" rm -f /data/order-app.deploy-backup.db /app/sqlite-online-backup.cjs >/dev/null 2>&1 || true
  docker exec "$WAREHOUSE_WORKER_CONTAINER" rm -f /data/db/warehouse-app.deploy-backup.sqlite /app/sqlite-online-backup.cjs >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker cp "$SCRIPT_DIR/sqlite-online-backup.cjs" "$ORDER_CONTAINER:/app/sqlite-online-backup.cjs"
docker cp "$SCRIPT_DIR/sqlite-online-backup.cjs" "$WAREHOUSE_WORKER_CONTAINER:/app/sqlite-online-backup.cjs"
docker exec "$ORDER_CONTAINER" node /app/sqlite-online-backup.cjs /data/app.db /data/order-app.deploy-backup.db
docker exec "$WAREHOUSE_WORKER_CONTAINER" node /app/sqlite-online-backup.cjs /data/db/app.sqlite /data/db/warehouse-app.deploy-backup.sqlite
docker cp "$ORDER_CONTAINER:/data/order-app.deploy-backup.db" "$backup_dir/order-app.before.db"
docker cp "$WAREHOUSE_WORKER_CONTAINER:/data/db/warehouse-app.deploy-backup.sqlite" "$backup_dir/warehouse-app.before.sqlite"
cleanup
trap - EXIT INT TERM
docker run --rm -v "$ORDER_DATA_VOLUME:/data:ro" -v "$backup_dir:/backup" alpine:3.20 sh -c 'if [ -d /data/uploads ]; then tar -czf /backup/order-uploads.before.tar.gz -C /data/uploads .; else tar -czf /backup/order-uploads.before.tar.gz --files-from /dev/null; fi'
docker run --rm -v "$WAREHOUSE_MEDIA_VOLUME:/media:ro" -v "$backup_dir:/backup" alpine:3.20 tar -czf /backup/warehouse-media.before.tar.gz -C /media .
tar -czf "$backup_dir/source.before.tar.gz" --exclude=.git --exclude=.env --exclude=node_modules --exclude='.next*' --exclude='.task-*' --exclude=uploads --exclude=data --exclude='*.tar.gz' .
cd "$backup_dir"
sha256sum order-app.before.db warehouse-app.before.sqlite order-uploads.before.tar.gz warehouse-media.before.tar.gz source.before.tar.gz compose.yaml compose.images.yaml integration.conf images.before.txt > SHA256SUMS
sha256sum -c SHA256SUMS
printf 'BACKUP_DIR=%s\n' "$backup_dir"
