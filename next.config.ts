import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static site in `out/`, served by Firebase Hosting.
  // The agent backend runs as a separate Cloud Run service.
  output: "export",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
