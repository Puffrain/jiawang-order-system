#!/bin/sh
set -eu

ROOT_DIR=${ROOT_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
WAREHOUSE_DIR="$ROOT_DIR/佳旺仓库系统"

major=$(node -p "Number(process.versions.node.split('.')[0])")
platform=$(node -p "process.platform")
if [ "$major" -ne 20 ] || [ "$platform" != "linux" ]; then
  echo "candidate validation requires Node 20 on Linux" >&2
  exit 2
fi

echo "[1/15] warehouse typecheck"
(cd "$WAREHOUSE_DIR" && pnpm run typecheck)

echo "[2/15] warehouse migration 020 -> 021"
(cd "$WAREHOUSE_DIR" && SOURCE_DIR="$WAREHOUSE_DIR" sh scripts/test-migration-021.sh)
(cd "$WAREHOUSE_DIR" && pnpm run test:migration-021)

echo "[3/15] warehouse inventory runtime"
(cd "$WAREHOUSE_DIR" && node --import tsx --test tests/domain/inventory-sync-runtime.test.ts)

echo "[4/15] warehouse outbox concurrency"
(cd "$WAREHOUSE_DIR" && node --import tsx --test tests/domain/order-sync-outbox-runtime.test.ts)

echo "[5/15] warehouse coordination safety"
(cd "$WAREHOUSE_DIR" && node --import tsx --test tests/domain/coordination-safety-contract.test.ts)

echo "[6/15] warehouse media stream"
(cd "$WAREHOUSE_DIR" && node --import tsx --test tests/pipeline/media-stream.test.ts)

echo "[7/15] warehouse production build"
(cd "$WAREHOUSE_DIR" && pnpm run build)

echo "[8/15] cross-system contracts"
(cd "$ROOT_DIR" && node tests/integration/cross-system-sync-contract.mjs && node tests/integration/product-archive-sync-contract.mjs)

echo "[9/15] chat order navigation contract"
(cd "$ROOT_DIR" && node tests/integration/chat-order-navigation-contract.mjs)

echo "[10/15] order projection runtime"
(cd "$ROOT_DIR" && node --import tsx tests/integration/warehouse-projection-runtime.mts)

echo "[11/15] order media concurrency and standalone retry"
(cd "$ROOT_DIR" && node --import tsx tests/integration/warehouse-media-concurrency-runtime.mts)

echo "[12/15] loyalty runtime"
(cd "$ROOT_DIR" && node --import tsx tests/integration/loyalty-ledger.mjs)

echo "[13/15] order typecheck"
(cd "$ROOT_DIR" && pnpm run typecheck)

echo "[14/15] order production build"
(cd "$ROOT_DIR" && pnpm run build)

echo "[15/15] candidate and isolated preview safety"
(cd "$ROOT_DIR" && node tests/integration/isolated-preview-compose-contract.mjs && node tests/integration/candidate-release-scripts-contract.mjs)

echo "Node 20/Linux candidate validation: PASS"
