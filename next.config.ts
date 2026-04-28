import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  // Build safety re-enabled — was ignoring all type errors. Flip these on so
  // CI/builds catch undefined-variable bugs before they ship.
  typescript: { ignoreBuildErrors: false },
  output: 'standalone',
};

export default nextConfig;
