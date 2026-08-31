import type { SqliteDatabase } from './db';

export function resolveControlledAssetIds(db: SqliteDatabase, assetIds: string[]): string[] {
  const resolved = assetIds.map((assetId) => {
    const asset = db.prepare('SELECT id, mime_type mimeType, derivative_kind derivativeKind FROM pipeline_assets WHERE id = ?').get(assetId) as { id: string; mimeType: string; derivativeKind: string | null } | undefined;
    if (!asset || !asset.mimeType.startsWith('image/')) throw new Error('Product image does not exist or is not an image');
    if (asset.derivativeKind) return asset.id;
    const derivative = db.prepare(`SELECT id, mime_type mimeType FROM pipeline_assets WHERE source_asset_id = ? AND derivative_kind IS NOT NULL ORDER BY CASE derivative_kind WHEN 'normalized' THEN 0 WHEN 'thumbnail' THEN 1 ELSE 2 END, created_at, id LIMIT 1`).get(asset.id) as { id: string; mimeType: string } | undefined;
    if (!derivative || !derivative.mimeType.startsWith('image/')) throw new Error('Product image has not been processed yet');
    return derivative.id;
  });
  if (new Set(resolved).size !== resolved.length) throw new Error('Product images must be unique');
  return resolved;
}
