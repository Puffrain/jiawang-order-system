import { ensureBootstrapAdmin } from '@/lib/auth';
import { getDb, healthCheck } from '@/lib/db';

function main(): void {
  const args = new Set(process.argv.slice(2));
  getDb();
  const health = healthCheck();
  process.stdout.write(`Database ready (journal=${health.journalMode}, migrations=${health.migrations})\n`);

  if (args.has('--admin')) {
    if (!process.env.BOOTSTRAP_ADMIN_USERNAME || !process.env.BOOTSTRAP_ADMIN_PASSWORD) {
      throw new Error('BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD are required with --admin');
    }
    const created = ensureBootstrapAdmin();
    process.stdout.write(created ? `Bootstrap administrator created: ${created.username}\n` : 'Bootstrap administrator already exists\n');
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Bootstrap failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

