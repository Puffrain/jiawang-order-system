// Next's route analyzer requires these values to be declared as literals in
// this file; re-export only the handler from the canonical password route.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export { POST } from '../password/route';
