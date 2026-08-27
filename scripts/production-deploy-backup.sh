#!/bin/sh
set -eu

timestamp=$(date +%Y%m%d-%H%M%S)
backup_dir="/root/jiawang-backups/${timestamp}-cross-system-media-worker-v2"
app_dir=/opt/jiawang-commerce-new

install -d -m 700 "$backup_dir"
cd "$app_dir"
cp compose.yaml compose.images.yaml proxy/integration.conf "$backup_dir/"
install -m 600 .env "$backup_dir/.env.before"
docker inspect jiawang-commerce-order-web-1 jiawang-commerce-warehouse-web-1 jiawang-commerce-warehouse-worker-1 --format '{{.Name}} {{.Config.Image}} {{.Image}}' > "$backup_dir/images.before.txt"

docker cp /tmp/sqlite-online-backup.cjs jiawang-commerce-order-web-1:/app/sqlite-online-backup.cjs
docker cp /tmp/sqlite-online-backup.cjs jiawang-commerce-warehouse-worker-1:/app/sqlite-online-backup.cjs
docker exec jiawang-commerce-order-web-1 node /app/sqlite-online-backup.cjs /data/app.db /data/order-app.deploy-backup.db
docker exec jiawang-commerce-warehouse-worker-1 node /app/sqlite-online-backup.cjs /data/db/app.sqlite /data/db/warehouse-app.deploy-backup.sqlite
docker cp jiawang-commerce-order-web-1:/data/order-app.deploy-backup.db "$backup_dir/order-app.before.db"
docker cp jiawang-commerce-warehouse-worker-1:/data/db/warehouse-app.deploy-backup.sqlite "$backup_dir/warehouse-app.before.sqlite"
docker exec jiawang-commerce-order-web-1 rm -f /data/order-app.deploy-backup.db /app/sqlite-online-backup.cjs
docker exec jiawang-commerce-warehouse-worker-1 rm -f /data/db/warehouse-app.deploy-backup.sqlite /app/sqlite-online-backup.cjs

docker run --rm -v jiawang-commerce-new-warehouse-media:/media:ro -v "$backup_dir:/backup" alpine:3.20 tar -czf /backup/warehouse-media.before.tar.gz -C /media .
tar -czf "$backup_dir/source.before.tar.gz" --exclude=.env --exclude=node_modules --exclude='.next*' --exclude='*.tar.gz' --exclude=data .

cd "$backup_dir"
sha256sum order-app.before.db warehouse-app.before.sqlite warehouse-media.before.tar.gz source.before.tar.gz compose.yaml compose.images.yaml integration.conf images.before.txt > SHA256SUMS
sha256sum -c SHA256SUMS
printf 'BACKUP_DIR=%s\n' "$backup_dir"
