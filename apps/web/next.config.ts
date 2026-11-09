import type { NextConfig } from 'next';

// Environment loading and the live-transport guard run in src/instrumentation.ts,
// where workspace TypeScript packages can be imported.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@trendpilot/domain', '@trendpilot/db'],
  serverExternalPackages: ['pg', '@node-rs/argon2', 'nodemailer'],
  // SIG-01: the webhook URL contains the ingress token. Never print it in the dev request log.
  // (Production builds do not log incoming requests.)
  logging: { incomingRequests: { ignore: [/\/v1\/webhooks\//] } },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' }
        ]
      }
    ];
  }
};

export default config;
