import type { NextConfig } from "next";
import packageJson from "./package.json" assert { type: "json" };

const nextConfig: NextConfig = {
  trailingSlash: true,
  images: {
    unoptimized: true
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: `v${packageJson.version}`,
  },
};

export default nextConfig;
