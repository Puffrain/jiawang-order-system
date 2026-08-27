export interface ColorVariantBase {
  localId: string;
  specification: string;
  sku: string;
  barcodeRaw: string;
  color: string;
}

export function parseUniqueColors(input: string, limit = 100): string[] {
  const entries = input.split(/[\n,，、;；]+/).map((value) => value.trim()).filter(Boolean);
  return [...new Map(entries.map((color) => [color.toLowerCase(), color])).values()].slice(0, Math.max(0, limit));
}

export function generateColorVariants<T extends ColorVariantBase>(input: {
  existing: T[];
  template: T;
  colorText: string;
  createId: () => string;
  limit?: number;
}): { colors: string[]; generated: T[]; variants: T[] } {
  const limit = Math.max(1, input.limit ?? 100);
  const colors = parseUniqueColors(input.colorText, limit);
  const existingColors = new Set(input.existing.map((variant) => variant.color.trim().toLowerCase()).filter(Boolean));
  const replaceBlankTemplate = input.existing.length === 1 && !input.template.specification.trim() && !input.template.color.trim();
  const capacity = replaceBlankTemplate ? limit : Math.max(0, limit - input.existing.length);
  const generated = colors
    .filter((color) => !existingColors.has(color.toLowerCase()))
    .slice(0, capacity)
    .map((color) => ({ ...input.template, localId: input.createId(), specification: color, sku: "", barcodeRaw: "", color }));
  return {
    colors,
    generated,
    variants: replaceBlankTemplate ? generated : [...input.existing, ...generated],
  };
}
