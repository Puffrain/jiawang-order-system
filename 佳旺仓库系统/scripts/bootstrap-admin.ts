import { ensureBootstrapAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';

getDb();
const created = ensureBootstrapAdmin();
if (!process.env.BOOTSTRAP_ADMIN_USERNAME || !process.env.BOOTSTRAP_ADMIN_PASSWORD) {
  throw new Error('BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD must be set');
}
process.stdout.write(created ? `Administrator created: ${created.username}\n` : 'Administrator already exists\n');

