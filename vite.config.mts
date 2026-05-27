import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte({ preprocess: vitePreprocess() })],
  base: "./",
  root: "webview",
  build: {
    outDir: "../dist/webview",
    emptyOutDir: false,
  },
  optimizeDeps: {
    exclude: ['shiki'],
  },
});
