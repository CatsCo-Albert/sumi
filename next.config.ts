import type { NextConfig } from "next";

/**
 * When Sumi is published behind the artifact gateway it is served under
 * `/<app-id>/`, and the gateway strips that prefix before forwarding. Absolute
 * asset URLs emitted by Next.js (`/_next/static/...`) would therefore resolve
 * against the gateway root instead of the application.
 *
 * NEXT_PUBLIC_BASE_PATH makes the build emit `/sumi/_next/static/...` instead,
 * and the deployment front door puts the prefix back before handing the request
 * to Next. Left empty for local development, where Sumi is served at the root.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default nextConfig;
