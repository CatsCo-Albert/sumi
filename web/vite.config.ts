import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";

export default defineConfig({
  plugins: [solid()],
  base: process.env.PUBLIC_BASE_PATH || "/sumi/",
  build: { outDir: "dist", target: "es2022", sourcemap: true },
});
