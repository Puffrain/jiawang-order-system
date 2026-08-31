import { createHash } from 'node:crypto';

export interface BackupManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
  kind: 'database' | 'original' | 'derivative' | 'metadata';
}

export interface BackupManifest {
  format: 'jwbackup';
  version: 1;
  appVersion: string;
  schemaVersion: string;
  createdAt: string;
  entries: BackupManifestEntry[];
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function validateManifest(manifest: unknown): manifest is BackupManifest {
  if (!manifest || typeof manifest !== 'object') return false;
  const value = manifest as Partial<BackupManifest>;
  if (value.format !== 'jwbackup' || value.version !== 1 || !Array.isArray(value.entries)
    || typeof value.appVersion !== 'string' || value.appVersion.length > 128
    || typeof value.schemaVersion !== 'string' || value.schemaVersion.length > 128
    || typeof value.createdAt !== 'string' || value.createdAt.length > 128
    || value.entries.length > 100_000) return false;
  return value.entries.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const candidate = entry as Partial<BackupManifestEntry>;
    const pathValue = candidate.path;
    const segments = typeof pathValue === 'string' ? pathValue.split('/') : [];
    return typeof pathValue === 'string'
      && pathValue.length > 0 && pathValue.length <= 4096
      && !pathValue.includes('\\') && !pathValue.startsWith('/')
      && !pathValue.includes(':')
      && !/^[A-Za-z]:/.test(pathValue) && !pathValue.startsWith('//')
      && !pathValue.includes('\0')
      && !segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/.test(segment) || /[ .]$/.test(segment) || isWindowsReservedName(segment))
      && typeof candidate.bytes === 'number'
      && Number.isSafeInteger(candidate.bytes)
      && candidate.bytes >= 0
      && typeof candidate.sha256 === 'string'
      && /^[0-9a-f]{64}$/i.test(candidate.sha256)
      && ['database', 'original', 'derivative', 'metadata'].includes(candidate.kind ?? '');
  });
}

function isWindowsReservedName(value: string): boolean {
  const base = value.split('.')[0]?.toUpperCase();
  return Boolean(base && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base));
}
