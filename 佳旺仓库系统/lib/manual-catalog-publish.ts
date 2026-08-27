import { validateForPublish } from './contracts/catalog';
import type { BeautyProductInput } from './contracts/catalog';

export function assertManualProductReady(input: BeautyProductInput): void {
  const validation = validateForPublish(input);
  const readiness = validation.errors.map((item) => item.message);
  if (!input.assetIds?.length) readiness.push('A processed product image is required');
  input.variants.forEach((variant, index) => {
    if (variant.price == null) readiness.push(`Variant ${index + 1} requires a price`);
    if (variant.stock == null) readiness.push(`Variant ${index + 1} requires stock`);
  });
  if (readiness.length) throw Object.assign(new Error(readiness.join('; ')), { code: 'PRODUCT_NOT_READY', status: 409 });
}
