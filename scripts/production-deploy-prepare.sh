#!/bin/sh
set -eu

command -v docker >/dev/null 2>&1 || { echo DOCKER_UNAVAILABLE; exit 3; }
docker compose version >/dev/null 2>&1 || { echo DOCKER_COMPOSE_UNAVAILABLE; exit 3; }

app_dir=/opt/jiawang-commerce-new
candidate_dir=/tmp/jiawang-commerce-sync-20260818
deploy_override=/tmp/compose.deploy-20260818.yaml

cd "$candidate_dir"
node scripts/validate-compose-build.mjs

current_master=$(docker inspect jiawang-commerce-warehouse-web-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^APP_MASTER_KEY=//p')
next_master=$(sed -n 's/^APP_MASTER_KEY=//p' "$app_dir/.env")
test -n "$current_master"
test -n "$next_master"
if [ "$current_master" != "$next_master" ]; then
  echo APP_MASTER_KEY_CHANGED_BLOCK
  exit 42
fi
echo APP_MASTER_KEY_UNCHANGED

docker tag jiawang-commerce-order:candidate-20260818-v2 jiawang-commerce-order:deploy-20260818
docker tag jiawang-commerce-warehouse-web:candidate-20260818 jiawang-commerce-warehouse-web:deploy-20260818
docker tag jiawang-commerce-warehouse-worker:candidate-20260818 jiawang-commerce-warehouse-worker:deploy-20260818
sed -e 's/jiawang-commerce-order:deploy/jiawang-commerce-order:deploy-20260818/g' -e 's/jiawang-commerce-warehouse-web:deploy/jiawang-commerce-warehouse-web:deploy-20260818/g' -e 's/jiawang-commerce-warehouse-worker:deploy/jiawang-commerce-warehouse-worker:deploy-20260818/g' "$candidate_dir/compose.images.yaml" > "$deploy_override"

docker compose --env-file "$app_dir/.env" -f "$candidate_dir/compose.yaml" -f "$deploy_override" config --quiet
docker compose --env-file "$app_dir/.env" -f "$candidate_dir/compose.yaml" -f "$deploy_override" config | grep -E 'image: jiawang-commerce-(order|warehouse)|name: jiawang-commerce-new-(order-data|warehouse-data|warehouse-media)|order-media-worker:'
