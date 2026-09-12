import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
