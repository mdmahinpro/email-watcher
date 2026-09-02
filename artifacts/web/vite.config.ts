import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// The Replit artifact config injects PORT and BASE_PATH (see
// .replit-artifact/artifact.toml). For local runs outside that environment they
// are optional and fall back to the dev defaults below; the API server owns
// 3001 (see the /api proxy target) and CORS allows 5173 by default.
const DEFAULT_DEV_PORT = 5173;
const DEFAULT_BASE_PATH = "/";

const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : DEFAULT_DEV_PORT;

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH || DEFAULT_BASE_PATH;

// Dev-server proxy target for /api. Keep in sync with the api-server PORT.
const apiTarget =
  process.env.API_PROXY_TARGET ?? `http://localhost:${process.env.API_PORT ?? 3001}`;

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // The app is served from a free-tier host on a metered connection, and the
    // first paint only needs the shell. Splitting the two heaviest independent
    // libraries out means a dashboard visit no longer downloads recharts before
    // anything renders, and a chunk that has not changed stays cached across
    // deploys.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "wouter"],
          charts: ["recharts"],
        },
      },
    },
    // With the vendor chunks split out, anything still over this is worth
    // knowing about rather than routinely ignoring.
    chunkSizeWarningLimit: 600,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
