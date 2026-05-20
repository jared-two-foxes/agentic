import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  base: "./",
  root: "webview",
  build: {
    outDir: "../dist/webview",
    emptyOutDir: false,
  },
});
