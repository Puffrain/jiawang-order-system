#!/bin/sh
set -eu

ROOT_DIR=${ROOT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
: "${CANDIDATE_ID:?set CANDIDATE_ID to a lowercase version identifier}"
case "$CANDIDATE_ID" in
  *[!a-z0-9-]*|''|-*|*-) echo "CANDIDATE_ID must use lowercase letters, digits and internal hyphens" >&2; exit 2 ;;
esac

order_tag="jiawang-commerce-order:candidate-$CANDIDATE_ID"
warehouse_web_tag="jiawang-commerce-warehouse-web:candidate-$CANDIDATE_ID"
warehouse_worker_tag="jiawang-commerce-warehouse-worker:candidate-$CANDIDATE_ID"
manifest_dir="$ROOT_DIR/.task-runs/candidate-$CANDIDATE_ID"
manifest="$manifest_dir/images.tsv"
mkdir -p "$manifest_dir"

cd "$ROOT_DIR"
docker build --pull=false --tag "$order_tag" .
docker build --pull=false --target web --build-arg NEXT_PUBLIC_BASE_PATH=/warehouse --tag "$warehouse_web_tag" ./佳旺仓库系统
docker build --pull=false --target worker --tag "$warehouse_worker_tag" ./佳旺仓库系统

: > "$manifest"
for entry in "order:$order_tag" "warehouse-web:$warehouse_web_tag" "warehouse-worker:$warehouse_worker_tag"; do
  role=${entry%%:*}
  tag=${entry#*:}
  digest=$(docker image inspect --format "{{index .RepoDigests 0}}" "$tag" 2>/dev/null || true)
  if [ -z "$digest" ] || [ "$digest" = "<no value>" ]; then
    image_id=$(docker image inspect --format "{{.Id}}" "$tag")
    case "$image_id" in sha256:*) digest="$image_id" ;; *) echo "candidate image has no immutable digest: $tag" >&2; exit 1 ;; esac
  fi
  printf "%s\t%s\t%s\n" "$role" "$tag" "$digest" >> "$manifest"
done

while IFS="$(printf '\t')" read -r role tag digest; do
  docker run --rm --entrypoint node "$tag" -e "const m=Number(process.versions.node.split('.')[0]);if(m!==20)process.exit(2);console.log(process.versions.node)" >/dev/null
  case "$digest" in sha256:????????????????????????????????????????????????????????????????|*@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "invalid digest for $role" >&2; exit 1 ;; esac
done < "$manifest"

echo "candidate images and Node 20 runtime: PASS"
echo "manifest: $manifest"
