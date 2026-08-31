import { runPipelineWorker } from "./pipeline-worker";

if (process.argv[1] && /worker[\\/]index\.(t|j)s$/.test(process.argv[1])) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  runPipelineWorker({ jobId: process.env.PIPELINE_JOB_ID, signal: controller.signal }).catch((error) => {
    // Avoid printing provider keys or full filesystem paths.
    console.error("pipeline worker failed", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { runPipelineWorker };

