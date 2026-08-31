#!/bin/sh
set -eu

ROOT_DIR=${ROOT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
: "${PREVIEW_ID:?set PREVIEW_ID to a lowercase run identifier}"
: "${PREVIEW_ENV_FILE:?set PREVIEW_ENV_FILE to an isolated non-production environment file}"
: "${ORDER_CANDIDATE_IMAGE:?set ORDER_CANDIDATE_IMAGE}"
: "${WAREHOUSE_WEB_CANDIDATE_IMAGE:?set WAREHOUSE_WEB_CANDIDATE_IMAGE}"
: "${WAREHOUSE_WORKER_CANDIDATE_IMAGE:?set WAREHOUSE_WORKER_CANDIDATE_IMAGE}"
case "$PREVIEW_ID" in
  *[!a-z0-9-]*|''|-*|*-) echo "PREVIEW_ID must use lowercase letters, digits and internal hyphens" >&2; exit 2 ;;
esac
if [ ! -f "$PREVIEW_ENV_FILE" ]; then
  echo "isolated preview environment file does not exist" >&2
  exit 2
fi
env_name=$(basename -- "$PREVIEW_ENV_FILE")
case "$env_name" in
  .env|.env.*|production.env|production.env.*|*.production.env)
    echo "preview must not use a production environment file" >&2
    exit 2
    ;;
esac
if ! grep -Eq '^[[:space:]]*SMS_PREVIEW_MODE[[:space:]]*=[[:space:]]*true[[:space:]]*$' "$PREVIEW_ENV_FILE"; then
  echo "isolated preview requires SMS_PREVIEW_MODE=true" >&2
  exit 2
fi
if grep -Eq '^[[:space:]]*SEED_SAMPLE_PRODUCTS[[:space:]]*=[[:space:]]*true[[:space:]]*$' "$PREVIEW_ENV_FILE"; then
  echo "isolated preview must not seed sample products" >&2
  exit 2
fi
cd "$ROOT_DIR"
docker compose --env-file "$PREVIEW_ENV_FILE" -f compose.preview.yaml config --format json \
  | node scripts/assert-isolated-preview-compose.mjs
