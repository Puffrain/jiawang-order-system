import { prepareManualProductAsset } from './manual-product-media';

/** Resolve catalog image selections to controlled derivative assets before a product mutation. */
export async function prepareCatalogAssetIds(assetIds: string[] | undefined): Promise<string[] | undefined> {
  if (assetIds === undefined) return undefined;
  if (assetIds.length === 0) return assetIds;
  const preparedIds: string[] = [];
  for (const assetId of assetIds) {
    const prepared = await prepareManualProductAsset(assetId);
    preparedIds.push(prepared.id);
  }
  if (new Set(preparedIds).size !== preparedIds.length) {
    const error = Object.assign(new Error('商品图片不能重复'), { code: 'ASSET_DUPLICATE', status: 400 });
    throw error;
  }
  return preparedIds;
}
