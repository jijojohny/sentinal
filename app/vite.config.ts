import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// The node-polyfills plugin provides Buffer / global / process in the browser
// (Anchor + web3.js need them). Don't also `define` process.env — that conflicts
// with the polyfilled process and can blank the page.
export default defineConfig({
  plugins: [react(), nodePolyfills({ globals: { Buffer: true, global: true, process: true } })],
  server: { port: 5173 },
});
