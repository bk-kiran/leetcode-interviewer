import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-mode route indicator badge overlaps interactive elements in
  // bottom-left-anchored layouts (e.g. /normal's editor panel).
  devIndicators: false,
};

export default nextConfig;
