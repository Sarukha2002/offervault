import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    server: {
      port: 3000,
      open: true,
      proxy: {
        "/api/places": {
          target: "https://maps.googleapis.com",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/places/, "/maps/api/place"),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              const sep = proxyReq.path.includes("?") ? "&" : "?";
              proxyReq.path += `${sep}key=${env.GOOGLE_PLACES_API_KEY || ""}`;
              proxyReq.removeHeader("origin");
              proxyReq.removeHeader("referer");
            });
          },
        },
        "/api/anthropic": {
          target: "https://api.anthropic.com",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/anthropic/, "/v1"),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.setHeader("x-api-key", env.ANTHROPIC_API_KEY || "");
              proxyReq.setHeader("anthropic-version", "2023-06-01");
              proxyReq.removeHeader("origin");
              proxyReq.removeHeader("referer");
            });
          },
        },
      },
    },
  };
});
