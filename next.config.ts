import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.SENTINELPR_E2E === "1" ? ".next-e2e" : ".next",
  // Native/long-lived libs must stay outside the bundler (worker threads, engines, pg sockets).
  serverExternalPackages: [
    "bullmq",
    "ioredis",
    "playwright",
    "pg",
    "@prisma/adapter-pg",
    "@aws-sdk/client-s3",
    "pngjs",
    "pixelmatch",
  ],
  typedRoutes: false,
};

export default nextConfig;
