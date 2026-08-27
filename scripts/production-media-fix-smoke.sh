#!/bin/sh
set -eu

root=/tmp/jw-media-fix-test
network=jw-media-fix-net
docker rm -f jw-media-fix-worker jw-media-fix-warehouse >/dev/null 2>&1 || true
docker network rm "$network" >/dev/null 2>&1 || true
rm -rf "$root"
mkdir -p "$root/order" "$root/warehouse/db" "$root/warehouse/tmp" "$root/warehouse/backups" "$root/media"

docker cp /tmp/sqlite-online-backup.cjs jiawang-commerce-order-web-1:/app/sqlite-online-backup.cjs
docker exec jiawang-commerce-order-web-1 node /app/sqlite-online-backup.cjs /data/app.db /data/order-media-fix-smoke.db
docker cp jiawang-commerce-order-web-1:/data/order-media-fix-smoke.db "$root/order/app.db"
docker exec jiawang-commerce-order-web-1 rm -f /data/order-media-fix-smoke.db /app/sqlite-online-backup.cjs
cp /root/jiawang-backups/20260818-045822-cross-system-media-worker-v2/warehouse-app.before.sqlite "$root/warehouse/db/app.sqlite"
tar -xzf /root/jiawang-backups/20260818-045822-cross-system-media-worker-v2/warehouse-media.before.tar.gz -C "$root/media"
chmod -R 777 "$root"
docker network create "$network" >/dev/null

docker run -d --name jw-media-fix-warehouse --network "$network" --network-alias warehouse-web -e NODE_ENV=production -e NEXT_PUBLIC_BASE_PATH=/warehouse -e DATABASE_PATH=/data/db/app.sqlite -e DATABASE_URL=file:/data/db/app.sqlite -e DATA_DIR=/data -e MEDIA_DIR=/media -e TEMP_DIR=/data/tmp -e TMPDIR=/data/tmp -e BACKUP_OUT_DIR=/data/backups -e PIPELINE_MEDIA_ROOT=/media -e APP_ORIGIN=http://warehouse-web:3000 -e REQUIRE_ORIGIN=true -e REQUIRE_CSRF=true -e APP_MASTER_KEY=0123456789abcdef0123456789abcdef -e INTEGRATION_SHARED_SECRET=abcdef0123456789abcdef0123456789 -e ORDER_INTERNAL_URL=http://order-web:3000 -v "$root/warehouse:/data" -v "$root/media:/media" jiawang-commerce-warehouse-web:deploy-20260818 >/dev/null
docker run -d --name jw-media-fix-worker --network "$network" -e DATABASE_URL=file:/data/app.db -e UPLOAD_DIR=/data/uploads -e NODE_ENV=production -e INTEGRATION_SHARED_SECRET=abcdef0123456789abcdef0123456789 -e WAREHOUSE_INTERNAL_URL=http://warehouse-web:3000 -e MEDIA_WORKER_POLL_MS=5000 -v "$root/order:/data" jiawang-commerce-order:candidate-20260818-v3 pnpm run worker:media >/dev/null
sleep 20
docker cp /tmp/production-data-check.cjs jw-media-fix-worker:/app/production-data-check.cjs
docker exec jw-media-fix-worker node /app/production-data-check.cjs order /data/app.db
docker inspect jw-media-fix-worker jw-media-fix-warehouse --format '{{.Name}} {{.State.Status}} restart={{.RestartCount}}'
docker logs --tail 30 jw-media-fix-worker
