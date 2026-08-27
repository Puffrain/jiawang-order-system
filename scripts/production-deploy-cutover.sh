#!/bin/sh
set -eu

app_dir=/opt/jiawang-commerce-new
candidate_dir=/tmp/jiawang-commerce-sync-20260818
deploy_override=/tmp/compose.deploy-20260818.yaml
backup_dir=/root/jiawang-backups/20260818-045822-cross-system-media-worker-v2

docker tag jiawang-commerce-order:rollback-20260817-231416 jiawang-commerce-order:rollback-20260818-before-sync
docker tag jiawang-commerce-warehouse-web:rollback-20260817-231416 jiawang-commerce-warehouse-web:rollback-20260818-before-sync
docker tag jiawang-commerce-warehouse-worker:rollback-20260817-231416 jiawang-commerce-warehouse-worker:rollback-20260818-before-sync

install -m 644 "$candidate_dir/compose.yaml" "$app_dir/compose.yaml"
install -m 644 "$deploy_override" "$app_dir/compose.images.yaml"

cd "$app_dir"
if ! docker compose -f compose.yaml -f compose.images.yaml up -d --no-build --force-recreate; then
  cp "$backup_dir/compose.yaml" compose.yaml
  cp "$backup_dir/compose.images.yaml" compose.images.yaml
  docker compose -f compose.yaml -f compose.images.yaml up -d --no-build --force-recreate
  echo CUTOVER_FAILED_ROLLED_BACK
  exit 1
fi

attempt=0
while [ "$attempt" -lt 24 ]; do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:8080/warehouse/api/health >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 5
done

if [ "$attempt" -ge 24 ]; then
  cp "$backup_dir/compose.yaml" compose.yaml
  cp "$backup_dir/compose.images.yaml" compose.images.yaml
  docker compose -f compose.yaml -f compose.images.yaml up -d --no-build --force-recreate
  echo HEALTH_FAILED_ROLLED_BACK
  exit 1
fi

docker compose -f compose.yaml -f compose.images.yaml ps
curl -fsS http://127.0.0.1:8080/api/health
printf '\n'
curl -fsS http://127.0.0.1:8080/warehouse/api/health
printf '\nCUTOVER_HEALTHY\n'
