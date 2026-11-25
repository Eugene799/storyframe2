import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser only ever talks to this dev/preview origin. /api is proxied to
// the local Node server, which is where the Ollama credentials live.
const apiPort =
  process.env.API_PORT?.trim() ||
  (process.env.PORT && process.env.PORT.trim() !== "3000" ? process.env.PORT.trim() : "8787");

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: Number(process.env.WEB_PORT?.trim() || 3000),
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 3000,
  },
});
