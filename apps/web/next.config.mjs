/** @type {import('next').NextConfig} */

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // CSP allows next.js inline styles + the image proxy + mangadex/komiku CDNs.
  {
    key: 'Content-Security-Policy',
    value: "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https://manga-api.oktz.workers.dev https://manga-api-3.tzok5555.workers.dev; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
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
