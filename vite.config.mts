import { defineConfig } from "vite";

// The launcher UI (Preact). Built to ui-dist/ and loaded by Electron from disk, so asset URLs are relative.
export default defineConfig({
  root: "src/ui",
  base: "./",
  publicDir: false,
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  build: {
    outDir: "../../ui-dist",
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: false,
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
  },
});
