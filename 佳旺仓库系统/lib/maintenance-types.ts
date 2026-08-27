/** Shared maintenance primitives kept in a dependency-free module so the
 * database write boundary can inspect the marker without importing the full
 * maintenance implementation (which itself imports the database). */
export const MAINTENANCE_SETTING_KEY = 'maintenance.mode';

export class MaintenanceError extends Error {
  constructor(
    message: string,
    readonly code: 'MAINTENANCE' | 'MAINTENANCE_BUSY' | 'MAINTENANCE_OWNER',
    readonly status: number,
  ) {
    super(message);
    this.name = 'MaintenanceError';
  }
}
