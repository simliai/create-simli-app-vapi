import type { NextConfig } from "next";

const securityHeaders = [
  // Only this site may frame the page. No connect-src: Simli and Vapi use
  // several WebSocket/WebRTC hosts that a strict CSP would have to track.
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  // The page needs the microphone (Vapi) and nothing else.
  { key: "Permissions-Policy", value: "microphone=(self), camera=()" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
