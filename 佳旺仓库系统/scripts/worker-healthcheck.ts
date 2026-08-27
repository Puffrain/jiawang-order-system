import fs from 'node:fs';
import { closeDb, healthCheck } from '@/lib/db';

try {
  const result = healthCheck();
  if (!result.ok || result.journalMode.toLowerCase() !== 'wal') throw new Error('database is not ready for WAL');
  // In a Linux container PID 1 is the worker command. This check catches a
  // stale health process after the worker has exited; it is skipped on hosts
  // without /proc (for example Windows development shells).
  const commandPath = '/proc/1/cmdline';
  if (fs.existsSync(commandPath)) {
    const command = fs.readFileSync(commandPath, 'utf8');
    if (!/worker/i.test(command)) throw new Error('worker process is not PID 1');
  }
  closeDb();
  process.stdout.write('worker health: ok\n');
} catch (error) {
  closeDb();
  process.stderr.write(`worker health: ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
}

