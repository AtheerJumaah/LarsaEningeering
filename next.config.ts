import type { NextConfig } from "next";

/* One config, four targets.
 *
 *   (default)              Cloudflare Workers through vinext — `npm run build`
 *   LARSA_TARGET=static    a plain folder of files — `npm run build:static`
 *   LARSA_TARGET=node      a normal Next.js server — `npm run build:node`
 *   (default, on Vercel)   Vercel's own Next.js runtime — `npm run build:vercel`
 *
 * Vercel needs the same unmodified config as the Cloudflare default (no
 * `output` override) — it builds and serves a standard Next.js app on its
 * own, so build:vercel is just `next build` with LARSA_TARGET unset.
 *
 * The application is entirely client-side: no API routes, no server
 * components, no server-only data access. That is what makes the static
 * target possible at all, and it is why the same source can be pointed at
 * whichever host you end up choosing.
 */
const target = process.env.LARSA_TARGET;

const nextConfig: NextConfig = {
  ...(target === "static"
    ? {
      output: "export",
      // The export has no server to resize images on request, and the only
      // images are the logo and the app icons, already at the right size.
      images: { unoptimized: true },
      // Plain file hosts serve /path/ as /path/index.html far more reliably
      // than they serve an extensionless /path.
      trailingSlash: true,
    }
    : {}),
  ...(target === "node" ? { output: "standalone" } : {}),
};

export default nextConfig;
