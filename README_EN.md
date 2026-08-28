# Jiawang Order System

English | [中文](README.md)

Jiawang Order System is a monorepo for order management, product catalog operations, warehouse review, and media synchronization. The current product workflow prioritizes manual product entry and human approval. AI configuration endpoints remain available but are not required for normal operations.

## Components

- Order Web: customer access, catalog, cart, orders, chat, and merchant operations.
- Order Media Worker: asynchronous warehouse image synchronization.
- Warehouse Web: manual product entry, variants, inventory, review, and publication.
- Warehouse Worker: background jobs, order synchronization, and media processing.
- Nginx Gateway: order routes at `/` and warehouse routes under `/warehouse`.
- SQLite: separate order and warehouse databases stored in Docker named volumes.

## Stack

- Node.js 20, Next.js, React, TypeScript
- pnpm
- SQLite / better-sqlite3
- Docker Compose and Nginx
- GitHub Actions

## Local Development

Requirements: Node.js 20, pnpm 10, and Docker Desktop for isolated previews.

```bash
pnpm install --frozen-lockfile
pnpm --dir 佳旺仓库系统 install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run build
```

Run the order development server with `pnpm dev`. Run `pnpm dev` inside `佳旺仓库系统` for the warehouse application. Never use production databases or production upload directories for local development.

## Isolated Preview

The preview environment uses fresh named volumes and never connects to production data. Create a local environment file based on `preview.env.example`, then run:

```bash
PREVIEW_ID=my-preview \
PREVIEW_ENV_FILE=/absolute/path/preview.env \
ORDER_CANDIDATE_IMAGE=repository/order@sha256:REPLACE_WITH_64_HEX_DIGEST \
WAREHOUSE_WEB_CANDIDATE_IMAGE=repository/warehouse-web@sha256:REPLACE_WITH_64_HEX_DIGEST \
WAREHOUSE_WORKER_CANDIDATE_IMAGE=repository/warehouse-worker@sha256:REPLACE_WITH_64_HEX_DIGEST \
./scripts/start-isolated-preview.sh
```

All three image variables must use immutable SHA-256 digests for the reviewed candidate. Do not use `latest`. `scripts/build-node20-candidates.sh` produces the image manifest.

The default entry point is `http://127.0.0.1:3113`. Health endpoints are `/api/health` and `/warehouse/api/health`.

## Tests and CI

GitHub Actions runs on Node.js 20 and covers secret scanning, type checks, linting, production builds, order business flows, cross-system synchronization, the warehouse test suite, Compose contracts, three candidate image builds, and a real order-image startup smoke test.

```bash
pnpm run scan:secrets
pnpm run test:deployment-config
pnpm run test:regression
pnpm run test:business-flows
pnpm run test:cross-system
pnpm --dir 佳旺仓库系统 test
```

## Production Configuration

Production requires explicit `APP_ORIGIN`, `APP_MASTER_KEY`, `SESSION_SECRET`, and `INTEGRATION_SHARED_SECRET` values. Real credentials belong only in controlled server environment files or operating-system credential stores. They must never be committed to GitHub or included in documentation or chat messages.

This repository contains no production databases, customer records, uploaded media, backup archives, certificates, or real secrets.

## Release Safety

See the [release runbook](docs/RELEASE_RUNBOOK.md) for the full workflow: candidate images, isolated preview, independent review, owner approval, online backup, checksum verification, cutover, health checks, and read-only validation.

If a failure occurs after a database migration, the deployment stops for explicit recovery approval. It does not automatically reconnect old images to a potentially incompatible schema. Production changes require explicit owner approval for the exact candidate release.

## Project Documentation

- [Release runbook](docs/RELEASE_RUNBOOK.md)
- [Acceptance report](docs/ACCEPTANCE_REPORT_20260828.md)
- [Project context](PROJECT_CONTEXT.md)
- [Current plan](PLANS.md)
- [Task state](TASK_STATE.md)

## License

Source code is licensed under the [MIT License](LICENSE). Business data, trademarks, server credentials, and customer information are outside the scope of this source-code license.
