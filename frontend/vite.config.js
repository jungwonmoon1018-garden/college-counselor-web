import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // The student app and counselor-only administrator surface are separate
      // entry points. Desktop uses privileged Electron IPC; website deployment
      // uses authenticated same-origin API calls. Student pages never handle
      // installation keys.
      input: {
        main: resolve(__dirname, "index.html"),
        admin: resolve(__dirname, "admin.html"),
        methodology: resolve(__dirname, "methodology.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.js",
    clearMocks: true,
  },
});
