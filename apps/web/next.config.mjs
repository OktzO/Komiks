/** @type {import('next').NextConfig} */

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // CSP allows next.js inline styles + the image proxy + mangadex/komiku CDNs.
  {
    key: 'Content-Security-Policy',
    value: "default-src 'self'; img-src 'self' data: https: https://manga-api.oktz.workers.dev https://manga-api-2.tzok5555.workers.dev https://manga-api-3.dwikaoktyffan.workers.dev; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com; connect-src 'self' https://manga-api.oktz.workers.dev https://manga-api-2.tzok5555.workers.dev https://manga-api-3.dwikaoktyffan.workers.dev https://cloudflareinsights.com; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  },
];

const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  transpilePackages: ['@manga-platform/shared'],
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
