/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { webpack }) => {
    // @wagmi/connectors bundles a Coinbase "Base Account" connector (unused here — this app
    // only targets Celo) whose optional @coinbase/cdp-sdk dependency reaches for the whole
    // @x402/* payment-protocol package family, none of which are installed. Dead code path —
    // tell webpack not to try resolving any of it.
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\/|^accounts$/ }));
    return config;
  },
};

export default nextConfig;
