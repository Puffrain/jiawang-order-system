/** @type {import('next').NextConfig} */
// Windows developer workstations commonly do not have the privilege required
// for Next's standalone tracer to create dependency symlinks (especially when
// the checkout lives in OneDrive).  The production Docker image is Linux and
// still uses standalone output; an explicit env override is available for
// Windows hosts that have Developer Mode/symlink support enabled.
const useStandaloneOutput = process.env.NEXT_OUTPUT_STANDALONE === 'true' || process.platform !== 'win32';
const previewOrigins = process.env.LUFFY_PREVIEW_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [];
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '/warehouse',
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: ['127.0.0.1', 'localhost', ...previewOrigins],
  ...(useStandaloneOutput ? { output: 'standalone' } : {}),
  serverExternalPackages: ['better-sqlite3', 'sharp', 'yauzl'],
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
      ],
    }];
  },
};

export default nextConfig;
