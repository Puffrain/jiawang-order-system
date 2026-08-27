#!/bin/sh
set -eu

app_dir=/opt/jiawang-commerce-new
before=$(sha256sum "$app_dir/.env" | cut -d' ' -f1)
cp -a /tmp/jiawang-commerce-sync-20260818/. "$app_dir/"
install -m 644 /tmp/production.env.template "$app_dir/production.env.template"
after=$(sha256sum "$app_dir/.env" | cut -d' ' -f1)
test "$before" = "$after"
echo ENV_UNCHANGED

docker rm -f jw-media-fix-worker jw-media-fix-warehouse >/dev/null 2>&1 || true
docker network rm jw-media-fix-net >/dev/null 2>&1 || true
docker cp /tmp/production-data-check.cjs jiawang-commerce-order-web-1:/app/production-data-check.cjs
docker exec -e UPLOAD_DIR=/data/uploads jiawang-commerce-order-web-1 node /app/production-data-check.cjs order /data/app.db
docker exec jiawang-commerce-order-web-1 rm -f /app/production-data-check.cjs

for container in jiawang-commerce-order-web-1 jiawang-commerce-order-media-worker-1 jiawang-commerce-warehouse-web-1 jiawang-commerce-warehouse-worker-1; do
  echo "LOG_CHECK=$container"
  docker logs --since 5m "$container" 2>&1 | grep -Ei 'error|fatal|exception|failed' || true
done
df -h /
