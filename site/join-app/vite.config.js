import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import {nodePolyfills} from "vite-plugin-node-polyfills";

// Build to predictable, unhashed names so the Worker can serve them from R2 at
// /join/app.js and /join/app.css. Cache-busting is done with a ?v= query the
// Worker controls, not content hashes.
export default defineConfig({
  base: "/join/",
  // esbuild 0.28 treats Safari 14 destructuring as unsupported and cannot lower it.
  // The previous toolchain already emitted destructuring for this target.
  esbuild: {supported: {destructuring: true}},
  plugins: [react(), nodePolyfills({globals: {Buffer: true, global: true, process: true}})],
  build: {
    outDir: "dist",
    assetsDir: ".",
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        assetFileNames: "app.[ext]",
        chunkFileNames: "app-[name].js",
        manualChunks: undefined,
      },
    },
  },
});
