import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/**
 * Static export served by Caddy (research R1, R7). `trailingSlash` keeps the Starlight URLs
 * (`/guides/triage/`) and writes one `index.html` per folder, so old links resolve unchanged (R2).
 *
 * @type {import('next').NextConfig}
 */
const config = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default withMDX(config);
