import {fileURLToPath} from 'node:url';
const webRoot=fileURLToPath(new URL('.',import.meta.url));
const gateway = (process.env.DRT_GATEWAY_URL || 'http://127.0.0.1:9251').replace(/\/$/, '');
if (!/^https?:\/\//.test(gateway)) throw new Error('DRT_GATEWAY_URL must be an HTTP URL');

/** @type {import('next').NextConfig} */
const config = {
  basePath: '/workspace',
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot:webRoot,
  turbopack:{root:webRoot},
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${gateway}/workspace/api/:path*` }];
  },
};
export default config;
