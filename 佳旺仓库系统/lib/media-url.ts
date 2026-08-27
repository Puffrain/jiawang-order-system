const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '/warehouse';

export function safeImageUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('/') && !url.startsWith('//')) return url.startsWith(`${basePath}/`) ? url : `${basePath}${url}`;
  if (url.startsWith('https://')) return url;
  return undefined;
}
