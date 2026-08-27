import { retryPendingWarehouseMedia } from "../lib/warehouse-product-media";
import { retryProductFileCleanup } from "../lib/product-file-cleanup";

const pollMs = Math.max(5_000, Number(process.env.MEDIA_WORKER_POLL_MS || 30_000));
const batchSize = Math.max(1, Math.min(20, Number(process.env.MEDIA_WORKER_BATCH_SIZE || 4)));

export async function runMediaWorkerOnce(options: { unlink?: typeof import("node:fs/promises").unlink } = {}) {
  try {
    await retryPendingWarehouseMedia(batchSize, options);
    await retryProductFileCleanup(batchSize * 5, options.unlink);
  } catch (error) {
    // A single failed batch must not terminate the long-running worker.
    console.error("media worker poll failed", error instanceof Error ? error.message : error);
  }
}

async function main() {
  await runMediaWorkerOnce();
  const timer = setInterval(() => { void runMediaWorkerOnce(); }, pollMs);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.env.MEDIA_WORKER_TEST_MODE !== "1") {
  void main().catch((error) => {
    console.error("media worker failed to start", error);
    process.exitCode = 1;
  });
}
