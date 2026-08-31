import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jiawang-db-bootstrap-"));
const database = path.join(directory, "app.db");
const command = "import('./lib/db.ts').then(() => process.exit(0))";

try {
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--eval", command], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${database}` },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolve({ code, stderr }));
  })));
  assert.deepEqual(results.map(result => result.code), Array(8).fill(0), results.map(result => result.stderr).join("\n"));
  process.stdout.write("database concurrent bootstrap: PASS\n");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
