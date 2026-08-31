import type { NextConfig } from "next";

const previewOrigins = process.env.LUFFY_PREVIEW_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
const warehouseOrigin = (process.env.WAREHOUSE_PREVIEW_ORIGIN || "http://127.0.0.1:3001").replace(/\/$/, "");

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["better-sqlite3"],
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.e2b.app", "*.e2b.dev", "*.luxiaofei.cc", ...previewOrigins],
  async rewrites() {
    return [
      { source: "/warehouse", destination: `${warehouseOrigin}/warehouse` },
      { source: "/warehouse/:path*", destination: `${warehouseOrigin}/warehouse/:path*` },
    ];
  },
};

export default nextConfig;
